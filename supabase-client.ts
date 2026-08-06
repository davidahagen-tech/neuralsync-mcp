// Supabase client for NeuralSynch Memory Packet system — v3.4 (S250 recall-parity)
//
// CHANGES FROM v3.3 (S250, recall + retrieval parity — ADDITIVE):
//   1. recallMemory() — NEW. The synthesizing recall path that mirrors the
//      direct-path edge function neuralsync-query for cross-path parity:
//        a. Generate a query embedding via Voyage AI (voyage-4-lite,
//           input_type='query', 3s timeout, 1024-dim shape check). On ANY
//           failure it falls back to a null embedding (FTS-only), exactly
//           like the direct path.
//        b. Call RPC search_ns_records_hybrid with p_query_embedding (vector
//           or null) and p_limit: 12. The RPC is already recency-aware;
//           recency params are intentionally omitted so its defaults apply.
//        c. Synthesize an answer with Anthropic (claude-haiku-4-5-20251001,
//           max_tokens 600) strictly from the returned records, emitting
//           "This is not yet in your IP store." when absent.
//      Returns { answer, citations, sources } where citations mirror the
//      field just added to neuralsync-query.
//   2. rpcCall() — NEW private service_role RPC helper. Mirrors the
//      Authorization/apikey header pattern of searchRecordsHybrid for the
//      retrieval RPCs (ns_get_recent, ns_get_latest_session, ns_get_by_session,
//      ns_filter_records, ns_current_session). One code path, one auth shape.
//   3. getRecent / getLatestSession / getBySession / filterRecords /
//      currentSession — NEW thin wrappers over rpcCall(), each forwarding the
//      named p_* RPC parameters with the documented defaults.
//   4. embedQuery() — NEW private helper: a 3s-timeout, non-cached query
//      embedding used only by recallMemory() so the recall path matches the
//      direct-path timeout contract. The cached getCachedEmbedding() used by
//      searchRecordsHybrid is UNCHANGED.
//
//   No existing behavior changed. All v3.3 methods, the embedding cache,
//   normalize helpers, ordinal lookup, hybrid search, and smart-close write
//   path are byte-for-byte identical to v3.3.
//
// CHANGES FROM v3.2 (S249, 2026-06-13):
//   1. SECURITY-DRIVEN: the substrate tables were publicly readable via the
//      hardcoded anon key (RLS was off / permissive {public} policies). That
//      exposure was closed S249 by enabling RLS and dropping all public/anon
//      read+write policies, keeping only service_role policies. Consequence:
//      the THREE methods that hit PostgREST/RPC directly with the anon key
//      (searchRecordsHybrid → rpc/search_ns_records_hybrid, fetchDecisionByOrdinal,
//      getMemoryStats) began returning "permission denied for table ns_records".
//   2. FIX: added private serviceKey, read from Deno env SUPABASE_SERVICE_ROLE_KEY
//      (falls back to anonKey if unset, so the server still boots). The three
//      direct-REST methods now present serviceKey in Authorization + apikey,
//      so PostgREST runs them as service_role (bypasses RLS). The public anon
//      key remains denied at the table level — the vault stays shut.
//   3. UNCHANGED: readMemoryPacket and writeSessionBack still use anonKey — they
//      call edge functions (retrieve-context-packet, neuralsync-smart-close)
//      which have JWT off and use their own internal service_role key, so they
//      were never affected by the lockdown. No change needed.
//   4. OPERATIONAL: SUPABASE_SERVICE_ROLE_KEY must be set as a Deno Deploy
//      environment SECRET for the neuralsync-mcp project. It must NEVER be
//      hardcoded in this file or committed to the repo (unlike anonKey, which
//      is public by design).
//
//   No other functional changes from v3.2. Voyage embedding cache, normalize
//   helpers, ordinal lookup logic, hybrid search flow, and smart-close write
//   path are all identical to v3.2.
//
// CHANGES FROM v3.1 (S187 close, preserved):
//   1. writeSessionBack — three diagnostic console.log checkpoints (CP1
//      entry, CP2 post-normalize, CP3 pre-POST) added in v3.1-diag have
//      been removed. The silent-drop they were meant to localize was
//      diagnosed as v2.1 MEMORY_TOOLS_SCHEMA declaring array fields with
//      bare items: { type: object } and no inner properties — strict MCP
//      client validators (claude.ai web framework specifically) treat as
//      ambiguous and silently drop contents. Fixed in memory-tools.ts
//      v2.2 by adding explicit properties + required + additionalProperties:
//      true to all five array-of-object item schemas. Verified end-to-end
//      via Cowork on 2026-05-03 (decision id cfd39dc5 + 12 subsequent
//      structured locks all returning ns_locked_decisions_ids non-empty).
//
//   2. The hoist `const stringifiedBody = JSON.stringify(payload)` —
//      added solely to feed CP3's byte-length log — has been removed;
//      the body is back to inline JSON.stringify(payload) at fetch time.
//
//   3. Log prefix tags updated from [mcp v3.1-diag] to [mcp v3.2] in all
//      console.error / console.log call sites across the file.
//
//   No functional changes from the v3.1 baseline. Network behavior,
//   normalize helpers, ordinal lookup, hybrid search, and embedding cache
//   are all identical to v3.1 / v3.1-diag.
//
// CHANGES FROM v3 (S174 Task 4, preserved through v3.1-diag and v3.2):
//   1. searchRecordsHybrid — adds Decision-ordinal lookup branch BEFORE
//      hybrid search, mirroring neuralsync-query v2.1.4 (S173 Task 2).
//      Pattern /\bdecision\s+(\d+)\b/i fires on the query; if matched,
//      fetchDecisionByOrdinal() retrieves the matching ns_locked_decisions
//      row, synthesizes a record-shaped object with match_source=
//      'ordinal_lookup' + combined_score=1.0, and prepends to results.
//      Hybrid search continues as supplement. Return type extended
//      (non-breaking) with ordinal_match field.
//
//   2. New private method fetchDecisionByOrdinal — queries
//      ns_locked_decisions where decision_ordinal=N, returns synthesized
//      record-shaped object so consumers can treat ordinal hits and
//      hybrid hits uniformly.
//
// CHANGES FROM v2 (S173 P3.5, preserved):
//   1. Embedding provider swapped from OpenAI to Voyage AI per Decision 10.
//      v3 reads VOYAGE_API_KEY_NEURALSYNCH, calls api.voyageai.com/v1/embeddings,
//      requests model voyage-4-lite (1024-dim), and adds input_type='query'
//      per Voyage best practice.
//
//   2. Added 1024-dim shape validation before caching. Per Decision 12
//      (schema reality beats decision aspiration).
//
// CHANGES FROM v1 (preserved):
//   1. searchMemory() — was: ilike substring match against non-existent
//      ns_memory_records table. Now: search_ns_records_hybrid() RPC.
//   2. writeSessionBack() — POSTs to /neuralsync-smart-close (P3 canonical).
//   3. getMemoryStats() — counts ns_records.
//   4. Embedding cache — module-level Map<query, {embedding, expires}>
//      with 5-min TTL.

export interface MemoryContext {
  success: boolean;
  client_id: string;
  session_number: number;
  context_prompt: string;
  locked_decisions_count: number;
  memory_records_count: number;
  anti_amnesia_status: string;
}

// v1 SessionWriteback shape (preserved for back-compat with callers that
// still pass this shape). The client translates it to smart-close v2 input
// at the network boundary.
export interface SessionWriteback {
  session_number: number;
  client_id: string;
  objective: string;
  outcome_summary: string;
  files_created?: Array<{ path?: string; file_path?: string; description?: string; type?: string; language?: string }>;
  files_modified?: Array<{ path?: string; file_path?: string; description?: string; changes?: string; type?: string; language?: string }>;
  decisions_made?: Array<{ decision?: string; title?: string; rationale: string; type?: string; decision_type?: string; priority?: number; confidence_score?: number; platform?: string }>;
  blockers_encountered?: Array<{ title: string; description: string; status?: string; error_type?: string }>;
  next_session_tasks?: any[];
  handoff_prompt?: string;
  carry_forward_context?: string;
  bolt_project?: string;
  platform_state?: Record<string, any>;
}

export interface SearchFilters {
  content_type?: string;
  domain?: string;
}

// v3.4 — filter params accepted by filterRecords() → ns_filter_records RPC.
// All optional; client_id is injected by the caller, never the model.
export interface FilterParams {
  content_type?: string;
  domain?: string;
  status?: string;
  tags?: string[];
  attributes?: Record<string, any>;
  title_ilike?: string;
  body_ilike?: string;
  since?: string;
  until?: string;
  order?: string;
  limit?: number;
}

// v3.4 — params accepted by getRecent() → ns_get_recent RPC.
export interface RecentParams {
  content_type?: string;
  domain?: string;
  status?: string;
  since?: string;
  limit?: number;
}

// v3.4 — shape returned by recallMemory().
export interface RecallResult {
  answer: string;
  citations: Array<Record<string, any>>;
  sources: any[];
}

// ─── Module-level embedding cache (5-min TTL, query-keyed) ──────────────
const EMBED_CACHE = new Map<string, { embedding: number[]; expires: number }>();
const EMBED_TTL_MS = 5 * 60 * 1000;

// ─── Voyage AI configuration (S173 — Decision 10 alignment) ─────────────
const VOYAGE_API_URL    = 'https://api.voyageai.com/v1/embeddings';
const VOYAGE_MODEL      = 'voyage-4-lite';
const VOYAGE_INPUT_TYPE = 'query';
const VOYAGE_DIM        = 1024;

// ─── Anthropic synthesis configuration (S250 — recall parity) ───────────
const ANTHROPIC_API_URL    = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL      = 'claude-haiku-4-5-20251001';
const ANTHROPIC_VERSION    = '2023-06-01';
const ANTHROPIC_MAX_TOKENS = 600;
const RECALL_EMBED_TIMEOUT_MS = 3000;

async function getCachedEmbedding(query: string): Promise<number[] | null> {
  const apiKey = Deno.env.get('VOYAGE_API_KEY_NEURALSYNCH');
  if (!apiKey) {
    return null;
  }
  const now = Date.now();
  const cached = EMBED_CACHE.get(query);
  if (cached && cached.expires > now) {
    return cached.embedding;
  }
  try {
    const res = await fetch(VOYAGE_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input:      [query],
        model:      VOYAGE_MODEL,
        input_type: VOYAGE_INPUT_TYPE,
      }),
    });
    if (!res.ok) {
      console.error(`[mcp v3.4] Voyage embedding ${res.status}: ${await res.text()}`);
      return null;
    }
    const data = await res.json();
    const embedding = data?.data?.[0]?.embedding;
    if (!Array.isArray(embedding)) {
      console.error('[mcp v3.4] Voyage embedding response missing data[0].embedding');
      return null;
    }
    if (embedding.length !== VOYAGE_DIM) {
      console.error(
        `[mcp v3.4] Voyage embedding dimension mismatch: expected ${VOYAGE_DIM}, ` +
        `got ${embedding.length}. Wrong model string? Falling back to FTS-only.`,
      );
      return null;
    }
    EMBED_CACHE.set(query, { embedding, expires: now + EMBED_TTL_MS });
    return embedding;
  } catch (err) {
    console.error(`[mcp v3.4] Voyage embedding error: ${(err as Error).message}`);
    return null;
  }
}

// ─── Recall-path query embedding (S250) — 3s timeout, FTS fallback ──────
// Mirrors the direct-path neuralsync-query embedding contract: a hard 3s
// timeout, 1024-dim shape check, and a null return on ANY failure so the
// caller silently degrades to FTS-only. Not cached (kept separate from
// getCachedEmbedding so the existing hybrid-search path is untouched).
async function embedQuery(question: string): Promise<number[] | null> {
  const apiKey = Deno.env.get('VOYAGE_API_KEY_NEURALSYNCH');
  if (!apiKey) {
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RECALL_EMBED_TIMEOUT_MS);
  try {
    const res = await fetch(VOYAGE_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input:      [question],
        model:      VOYAGE_MODEL,
        input_type: VOYAGE_INPUT_TYPE,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(`[mcp v3.4] recall embedding ${res.status}: ${await res.text()}`);
      return null;
    }
    const data = await res.json();
    const embedding = data?.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length !== VOYAGE_DIM) {
      console.error('[mcp v3.4] recall embedding shape invalid; falling back to FTS-only.');
      return null;
    }
    return embedding;
  } catch (err) {
    console.error(`[mcp v3.4] recall embedding error: ${(err as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Translation helpers (v1 SessionWriteback → smart-close v2 input) ──
function normalizeDecisions(input: SessionWriteback['decisions_made']): Array<Record<string, any>> {
  if (!Array.isArray(input)) return [];
  return input.map((d) => ({
    title: d.title ?? d.decision ?? 'Untitled decision',
    rationale: d.rationale ?? '',
    decision_type: d.decision_type ?? d.type ?? 'technical',
    priority: d.priority ?? 5,
    confidence_score: d.confidence_score ?? 0.95,
    platform: d.platform ?? null,
  }));
}

function normalizeFiles(input: SessionWriteback['files_created'] | SessionWriteback['files_modified']): Array<Record<string, any>> {
  if (!Array.isArray(input)) return [];
  return input.map((f) => ({
    file_path: f.file_path ?? f.path ?? 'unknown',
    description: f.description ?? null,
    language: f.language ?? f.type ?? null,
  }));
}

function normalizeBlockers(input: SessionWriteback['blockers_encountered']): Array<Record<string, any>> {
  if (!Array.isArray(input)) return [];
  return input.map((b) => ({
    title: b.title ?? 'Untitled blocker',
    description: b.description ?? '',
    status: b.status ?? 'open',
    error_type: b.error_type ?? 'general',
  }));
}

// ─── Client class ───────────────────────────────────────────────────────
export class NeuralSynchClient {
  private baseUrl: string;
  private anonKey: string;
  private serviceKey: string;

  constructor() {
    this.baseUrl = 'https://udafklielwqdppnagtwc.supabase.co';
    this.anonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVkYWZrbGllbHdxZHBwbmFndHdjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQzNTgxNzgsImV4cCI6MjA4OTkzNDE3OH0.0ueCBWNfdZGOHsLlJW9P3tUQ7QgD7tGmM6CQ1ZbOaAQ';
    // S249: service_role key for direct-REST/RPC calls that RLS now gates.
    // Read from Deno env SECRET — never hardcode service_role in this file.
    // Falls back to anonKey if unset so the server still boots (search/stats
    // will simply remain RLS-blocked until the env var is configured).
    this.serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? this.anonKey;
  }

  // ─── Memory packet read — unchanged from v1 (edge function, service_role internal) ──
  async readMemoryPacket(clientId: string = 'viralbrain'): Promise<MemoryContext> {
    try {
      const response = await fetch(
        `${this.baseUrl}/functions/v1/retrieve-context-packet?client_id=${clientId}`,
        {
          headers: {
            'Authorization': `Bearer ${this.anonKey}`,
            'apikey': this.anonKey,
          },
        },
      );
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return await response.json();
    } catch (error) {
      console.error('[mcp v3.4] Memory read failed:', error);
      throw new Error(`Failed to read memory packet: ${(error as Error).message}`);
    }
  }

  // ─── Hybrid search v3.1 — ordinal lookup BEFORE hybrid call ──────────
  async searchRecordsHybrid(
    query: string,
    clientId: string = 'viralbrain',
    limit: number = 10,
    filters: SearchFilters = {},
  ): Promise<{ results: any[]; mode: string; ordinal_match: number | null }> {
    // 1. Decision-ordinal lookup — fires BEFORE hybrid search.
    const ordinalMatch = query.match(/\bdecision\s+(\d+)\b/i);
    let ordinalRecord: any = null;
    let matchedOrdinal: number | null = null;
    if (ordinalMatch) {
      matchedOrdinal = parseInt(ordinalMatch[1], 10);
      ordinalRecord = await this.fetchDecisionByOrdinal(clientId, matchedOrdinal);
    }

    // 2. Hybrid search (existing path, unchanged behavior).
    const embedding = await getCachedEmbedding(query);
    const rpcBody: Record<string, any> = {
      p_client_id: clientId,
      p_query_text: query,
    };
    if (embedding) rpcBody.p_query_embedding = embedding;

    try {
      const res = await fetch(
        `${this.baseUrl}/rest/v1/rpc/search_ns_records_hybrid`,
        {
          method: 'POST',
          headers: {
            // S249: service_role — RLS gates ns_records against anon.
            'Authorization': `Bearer ${this.serviceKey}`,
            'apikey': this.serviceKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(rpcBody),
        },
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`hybrid search RPC ${res.status}: ${text}`);
      }
      let results: any[] = await res.json();
      if (!Array.isArray(results)) results = [];

      // Client-side filters
      if (filters.content_type) {
        results = results.filter((r) => r?.content_type === filters.content_type);
      }
      if (filters.domain) {
        results = results.filter((r) => r?.domain === filters.domain);
      }

      // 3. Prepend ordinal-matched record if any. Dedup by id in case
      // hybrid search also surfaced it (which is common — decisions
      // appear in ns_records via P7 backfill).
      if (ordinalRecord) {
        const dedup = results.filter((r) => r?.id !== ordinalRecord.id);
        results = [ordinalRecord, ...dedup];
      }

      return {
        results: results.slice(0, Math.max(1, Math.min(limit, 50))),
        mode: embedding ? 'hybrid' : 'fts_only',
        ordinal_match: matchedOrdinal,
      };
    } catch (error) {
      console.error('[mcp v3.4] Hybrid search failed:', error);
      throw new Error(`Failed to search ns_records: ${(error as Error).message}`);
    }
  }

  // ─── Decision-ordinal lookup helper (S174 Task 4) ────────────────────
  private async fetchDecisionByOrdinal(
    clientId: string,
    ordinal: number,
  ): Promise<any | null> {
    try {
      const url = `${this.baseUrl}/rest/v1/ns_locked_decisions` +
        `?client_id=eq.${clientId}` +
        `&decision_ordinal=eq.${ordinal}` +
        `&limit=1`;
      const res = await fetch(url, {
        headers: {
          // S249: service_role — RLS gates ns_locked_decisions against anon.
          'Authorization': `Bearer ${this.serviceKey}`,
          'apikey': this.serviceKey,
        },
      });
      if (!res.ok) {
        console.error(`[mcp v3.4] ordinal lookup ${res.status}: ${await res.text()}`);
        return null;
      }
      const arr = await res.json();
      if (!Array.isArray(arr) || arr.length === 0) return null;
      const d = arr[0];
      // Synthesize a record-shaped object so consumers can treat ordinal
      // hits and hybrid hits uniformly.
      return {
        id: d.id,
        title: d.title ?? `Decision ${ordinal}`,
        content_type: 'decision',
        domain: d.platform ?? null,
        status: 'active',
        body: d.rationale ?? '',
        similarity: 1.0,
        session_number: null,
        source_session: null,
        created_at: d.created_at,
        decision_ordinal: d.decision_ordinal,
        priority: d.priority,
        confidence_score: d.confidence_score,
        match_source: 'ordinal_lookup',
        combined_score: 1.0,
      };
    } catch (err) {
      console.error('[mcp v3.4] ordinal lookup error:', err);
      return null;
    }
  }

  // ─── Service-role RPC helper (S250) ──────────────────────────────────
  // Single POST path for the retrieval RPCs, mirroring the
  // Authorization/apikey header shape used by searchRecordsHybrid. PostgREST
  // runs the function as service_role (RLS gates these tables against anon).
  private async rpcCall(fn: string, body: Record<string, any>): Promise<any> {
    try {
      const res = await fetch(
        `${this.baseUrl}/rest/v1/rpc/${fn}`,
        {
          method: 'POST',
          headers: {
            // S250: service_role — RLS gates the substrate tables against anon.
            'Authorization': `Bearer ${this.serviceKey}`,
            'apikey': this.serviceKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`${fn} RPC ${res.status}: ${text}`);
      }
      return await res.json();
    } catch (error) {
      console.error(`[mcp v3.4] RPC ${fn} failed:`, error);
      throw new Error(`Failed to call ${fn}: ${(error as Error).message}`);
    }
  }

  // ─── Synthesizing recall (S250) — mirrors direct-path neuralsync-query ─
  async recallMemory(
    question: string,
    clientId: string = 'viralbrain',
  ): Promise<RecallResult> {
    // 1. Query embedding — 3s timeout, FTS fallback on any failure.
    const embedding = await embedQuery(question);

    // 2. Hybrid recall RPC. The RPC is already recency-aware; recency params
    //    are intentionally omitted so its defaults apply.
    const rpcBody: Record<string, any> = {
      p_client_id: clientId,
      p_query_text: question,
      p_query_embedding: embedding ?? null,
      p_limit: 12,
    };
    let records: any[] = await this.rpcCall('search_ns_records_hybrid', rpcBody);
    if (!Array.isArray(records)) records = [];

    // 3. Citations — mirrors the field just added to neuralsync-query.
    const citations = records.map((r: any) => ({
      id: r.id,
      title: r.title,
      content_type: r.content_type,
      domain: r.domain,
      session_number: r.session_number,
      match_source: r.match_source ?? undefined,
      score: typeof r.combined_score === 'number'
        ? Math.round(r.combined_score * 1000) / 1000
        : null,
    }));

    // 4. Synthesize the answer with Anthropic, strictly from the records.
    const answer = await this.synthesizeAnswer(question, records);

    return { answer, citations, sources: records };
  }

  // ─── Anthropic synthesis (S250) — answers ONLY from supplied records ──
  private async synthesizeAnswer(question: string, records: any[]): Promise<string> {
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    const absentMsg = 'This is not yet in your IP store.';
    if (!apiKey) {
      console.error('[mcp v3.4] ANTHROPIC_API_KEY unset — cannot synthesize recall answer.');
      return absentMsg;
    }
    if (!Array.isArray(records) || records.length === 0) {
      return absentMsg;
    }

    const context = records
      .map((r: any, i: number) => {
        const body = typeof r.body === 'string' ? r.body : '';
        return `[${i + 1}] (${r.content_type ?? 'record'} — ${r.title ?? 'untitled'})\n${body}`;
      })
      .join('\n\n');

    const prompt =
      `Answer the question using ONLY the NeuralSynch memory records below. ` +
      `Do not use outside knowledge. If the records do not contain the answer, ` +
      `reply with exactly: "${absentMsg}"\n\n` +
      `Records:\n${context}\n\n` +
      `Question: ${question}`;

    try {
      const res = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: ANTHROPIC_MAX_TOKENS,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) {
        console.error(`[mcp v3.4] Anthropic synthesis ${res.status}: ${await res.text()}`);
        return absentMsg;
      }
      const data = await res.json();
      const text = data?.content?.[0]?.text;
      return typeof text === 'string' && text.length > 0 ? text : absentMsg;
    } catch (err) {
      console.error(`[mcp v3.4] Anthropic synthesis error: ${(err as Error).message}`);
      return absentMsg;
    }
  }

  // ─── Recent records (S250) — ns_get_recent ───────────────────────────
  async getRecent(
    clientId: string = 'viralbrain',
    params: RecentParams = {},
  ): Promise<any[]> {
    const out = await this.rpcCall('ns_get_recent', {
      p_client_id: clientId,
      p_content_type: params.content_type ?? null,
      p_domain: params.domain ?? null,
      p_status: params.status ?? 'active',
      p_since: params.since ?? null,
      p_limit: params.limit ?? 20,
    });
    return Array.isArray(out) ? out : [];
  }

  // ─── Latest session (S250) — ns_get_latest_session ───────────────────
  async getLatestSession(
    clientId: string = 'viralbrain',
    status: string = 'active',
  ): Promise<any[]> {
    const out = await this.rpcCall('ns_get_latest_session', {
      p_client_id: clientId,
      p_status: status,
    });
    return Array.isArray(out) ? out : out;
  }

  // ─── Records by session (S250) — ns_get_by_session ───────────────────
  async getBySession(
    clientId: string = 'viralbrain',
    sessionNumber: number,
    status?: string,
  ): Promise<any[]> {
    const out = await this.rpcCall('ns_get_by_session', {
      p_client_id: clientId,
      p_session_number: sessionNumber,
      p_status: status ?? null,
    });
    return Array.isArray(out) ? out : [];
  }

  // ─── Filtered records (S250) — ns_filter_records ─────────────────────
  async filterRecords(
    clientId: string = 'viralbrain',
    params: FilterParams = {},
  ): Promise<any[]> {
    const out = await this.rpcCall('ns_filter_records', {
      p_client_id: clientId,
      p_content_type: params.content_type ?? null,
      p_domain: params.domain ?? null,
      p_status: params.status ?? null,
      p_tags: params.tags ?? null,
      p_attributes: params.attributes ?? null,
      p_title_ilike: params.title_ilike ?? null,
      p_body_ilike: params.body_ilike ?? null,
      p_since: params.since ?? null,
      p_until: params.until ?? null,
      p_order: params.order ?? null,
      p_limit: params.limit ?? null,
    });
    return Array.isArray(out) ? out : [];
  }

  // ─── Current session number (S250) — ns_current_session (bigint) ─────
  async currentSession(clientId: string = 'viralbrain'): Promise<number | null> {
    const out = await this.rpcCall('ns_current_session', {
      p_client_id: clientId,
    });
    // PostgREST returns a scalar RPC result directly (number) or as a wrapped
    // array depending on function signature; normalize to a plain number.
    if (typeof out === 'number') return out;
    if (Array.isArray(out) && out.length > 0) {
      const first = out[0];
      if (typeof first === 'number') return first;
      if (first && typeof first === 'object') {
        const v = first.ns_current_session ?? Object.values(first)[0];
        return typeof v === 'number' ? v : (v != null ? Number(v) : null);
      }
    }
    return out != null ? Number(out) : null;
  }

  // ─── Session writeback — unchanged from v3.2 (edge function, service_role internal) ──
  async writeSessionBack(
    writeback: SessionWriteback,
  ): Promise<{ success: boolean; message: string; details?: any }> {
    const normalizedDecisions = normalizeDecisions(writeback.decisions_made);
    const normalizedFilesCreated = normalizeFiles(writeback.files_created);
    const normalizedFilesModified = normalizeFiles(writeback.files_modified);
    const normalizedBlockers = normalizeBlockers(writeback.blockers_encountered);

    const payload = {
      client_id: writeback.client_id,
      session_number: writeback.session_number,
      objective: writeback.objective,
      outcome_summary: writeback.outcome_summary,
      decisions_made: normalizedDecisions,
      files_created: normalizedFilesCreated,
      files_modified: normalizedFilesModified,
      blockers_encountered: normalizedBlockers,
      next_session_tasks: writeback.next_session_tasks ?? [],
      carry_forward_context: writeback.carry_forward_context ?? null,
      handoff_prompt: writeback.handoff_prompt ?? null,
      bolt_project: writeback.bolt_project ?? null,
      platform_state: writeback.platform_state ?? {},
      trigger_source: 'mcp-write',
    };

    try {
      const response = await fetch(
        `${this.baseUrl}/functions/v1/neuralsync-smart-close`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.anonKey}`,
            'apikey': this.anonKey,
          },
          body: JSON.stringify(payload),
        },
      );

      const data = await response.json();

      if (!response.ok || data?.success === false) {
        const errMsg = data?.error || `HTTP ${response.status}: ${response.statusText}`;
        return {
          success: false,
          message: `smart-close failed: ${errMsg}`,
          details: data,
        };
      }

      return {
        success: true,
        message: `Session ${writeback.session_number} captured to substrate (mode: ${data?.mode ?? 'structured_writeback'})`,
        details: data,
      };
    } catch (error) {
      console.error('[mcp v3.4] Memory write failed:', error);
      return {
        success: false,
        message: `Failed to write session back: ${(error as Error).message}`,
      };
    }
  }

  // ─── Single record by id (S251) — full body, no excerpt ──────────────
  //
  // Returns the complete ns_records row, or null when no such row exists.
  // null is a definitive negative and callers must surface it as one; the
  // defect this replaces was an empty result presented as a successful read.
  async getRecordById(recordId: string): Promise<any | null> {
    try {
      const url = `${this.baseUrl}/rest/v1/ns_records` +
        `?id=eq.${encodeURIComponent(recordId)}` +
        `&select=id,title,body,content_type,domain,status,session_number,tags,attributes,created_at,client_id` +
        `&limit=1`;
      const res = await fetch(url, {
        headers: {
          // service_role — RLS gates ns_records against anon.
          'Authorization': `Bearer ${this.serviceKey}`,
          'apikey': this.serviceKey,
        },
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`ns_records fetch ${res.status}: ${text}`);
      }
      const rows = await res.json();
      if (!Array.isArray(rows) || rows.length === 0) return null;
      return rows[0];
    } catch (error) {
      console.error('[mcp v3.5] Record fetch by id failed:', error);
      throw new Error(`Failed to fetch ns_records row: ${(error as Error).message}`);
    }
  }

  // ─── Memory stats (fixed table reference) ────────────────────────────
  async getMemoryStats(clientId: string = 'viralbrain'): Promise<any> {
    try {
      const queries = [
        `${this.baseUrl}/rest/v1/ns_locked_decisions?client_id=eq.${clientId}&select=id`,
        `${this.baseUrl}/rest/v1/ns_records?client_id=eq.${clientId}&select=id`,
        `${this.baseUrl}/rest/v1/ns_session_writebacks?client_id=eq.${clientId}&select=id`,
      ];
      const responses = await Promise.all(
        queries.map((url) =>
          fetch(url, {
            headers: {
              // S249: service_role — RLS gates these tables against anon.
              'Authorization': `Bearer ${this.serviceKey}`,
              'apikey': this.serviceKey,
              'Prefer': 'count=exact',
              'Range-Unit': 'items',
              'Range': '0-0',
            },
          }),
        ),
      );
      const counts = responses.map((r) => {
        const cr = r.headers.get('Content-Range');
        if (!cr) return 0;
        const total = cr.split('/')[1];
        return total && total !== '*' ? parseInt(total, 10) : 0;
      });
      return {
        locked_decisions: counts[0] ?? 0,
        memory_records: counts[1] ?? 0,
        ns_records: counts[1] ?? 0,
        session_writebacks: counts[2] ?? 0,
        client_id: clientId,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('[mcp v3.4] Memory stats failed:', error);
      throw new Error(`Failed to get memory stats: ${(error as Error).message}`);
    }
  }
}
