// Supabase client for NeuralSynch Memory Packet system — v3.1-diag (S187)
//
// CHANGES FROM v3.1 (S187 substrate-hygiene diagnostic build):
//   1. writeSessionBack — adds three console.log checkpoints to localize
//      the silent-drop of structured arrays (decisions_made, files_created,
//      blockers_encountered, next_session_tasks). Diagnostic only; revert
//      to v3.1 once cause is identified and v3.2 patch is shipped.
//
//   2. Checkpoint 1 (entry): logs the SessionWriteback object received
//      from handleMemoryWrite — array typeof, isArray, length, full key
//      list. Tells us whether the drop happened upstream (memory_tools.ts
//      or MCP entry point) or downstream (in this file).
//
//   3. Checkpoint 2 (post-normalize): logs the normalized array lengths
//      after normalizeDecisions / normalizeFiles / normalizeBlockers.
//      Tells us if any normalize helper is silently returning [] for a
//      well-formed input (e.g., due to a paste artifact in the deployed
//      code, or a typeof mismatch).
//
//   4. Checkpoint 3 (pre-POST): logs the final payload's array lengths
//      and the byte length of the JSON-stringified body. Tells us if the
//      body construction itself is dropping anything before fetch.
//
//   No functional changes. Logs are additive. Network behavior identical
//   to v3.1.
//
// CHANGES FROM v3 (S174 Task 4, preserved through v3.1-diag):
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

// ─── Module-level embedding cache (5-min TTL, query-keyed) ──────────────
const EMBED_CACHE = new Map<string, { embedding: number[]; expires: number }>();
const EMBED_TTL_MS = 5 * 60 * 1000;

// ─── Voyage AI configuration (S173 — Decision 10 alignment) ─────────────
const VOYAGE_API_URL    = 'https://api.voyageai.com/v1/embeddings';
const VOYAGE_MODEL      = 'voyage-4-lite';
const VOYAGE_INPUT_TYPE = 'query';
const VOYAGE_DIM        = 1024;

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
      console.error(`[mcp v3.1-diag] Voyage embedding ${res.status}: ${await res.text()}`);
      return null;
    }

    const data = await res.json();
    const embedding = data?.data?.[0]?.embedding;

    if (!Array.isArray(embedding)) {
      console.error('[mcp v3.1-diag] Voyage embedding response missing data[0].embedding');
      return null;
    }

    if (embedding.length !== VOYAGE_DIM) {
      console.error(
        `[mcp v3.1-diag] Voyage embedding dimension mismatch: expected ${VOYAGE_DIM}, ` +
        `got ${embedding.length}. Wrong model string? Falling back to FTS-only.`,
      );
      return null;
    }

    EMBED_CACHE.set(query, { embedding, expires: now + EMBED_TTL_MS });
    return embedding;
  } catch (err) {
    console.error(`[mcp v3.1-diag] Voyage embedding error: ${(err as Error).message}`);
    return null;
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

  constructor() {
    this.baseUrl = 'https://udafklielwqdppnagtwc.supabase.co';
    this.anonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVkYWZrbGllbHdxZHBwbmFndHdjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQzNTgxNzgsImV4cCI6MjA4OTkzNDE3OH0.0ueCBWNfdZGOHsLlJW9P3tUQ7QgD7tGmM6CQ1ZbOaAQ';
  }

  // ─── Memory packet read — unchanged from v1 ──────────────────────────

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
      console.error('[mcp v3.1-diag] Memory read failed:', error);
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
            'Authorization': `Bearer ${this.anonKey}`,
            'apikey': this.anonKey,
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
      console.error('[mcp v3.1-diag] Hybrid search failed:', error);
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
          'Authorization': `Bearer ${this.anonKey}`,
          'apikey': this.anonKey,
        },
      });

      if (!res.ok) {
        console.error(`[mcp v3.1-diag] ordinal lookup ${res.status}: ${await res.text()}`);
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
      console.error('[mcp v3.1-diag] ordinal lookup error:', err);
      return null;
    }
  }

  // ─── Session writeback (S187 diagnostic — three log checkpoints) ─────

  async writeSessionBack(
    writeback: SessionWriteback,
  ): Promise<{ success: boolean; message: string; details?: any }> {

    // ───── DIAGNOSTIC CHECKPOINT 1 — entry shape from handleMemoryWrite ─
    // Logs the SessionWriteback object as it arrived. If the structured
    // arrays show isArray=false or length=0/undefined, the drop happened
    // upstream (in memory_tools.ts handleMemoryWrite or the MCP entry
    // point's JSON-RPC parsing).
    console.log('[mcp v3.1-diag] CP1 writeSessionBack entry:', JSON.stringify({
      session_number: writeback.session_number,
      client_id: writeback.client_id,
      objective_present: typeof writeback.objective === 'string' && writeback.objective.length > 0,
      outcome_summary_present: typeof writeback.outcome_summary === 'string' && writeback.outcome_summary.length > 0,
      decisions_made_typeof: typeof writeback.decisions_made,
      decisions_made_isArray: Array.isArray(writeback.decisions_made),
      decisions_made_length: Array.isArray(writeback.decisions_made) ? writeback.decisions_made.length : null,
      files_created_typeof: typeof writeback.files_created,
      files_created_isArray: Array.isArray(writeback.files_created),
      files_created_length: Array.isArray(writeback.files_created) ? writeback.files_created.length : null,
      files_modified_isArray: Array.isArray(writeback.files_modified),
      files_modified_length: Array.isArray(writeback.files_modified) ? writeback.files_modified.length : null,
      blockers_encountered_isArray: Array.isArray(writeback.blockers_encountered),
      blockers_encountered_length: Array.isArray(writeback.blockers_encountered) ? writeback.blockers_encountered.length : null,
      next_session_tasks_isArray: Array.isArray(writeback.next_session_tasks),
      next_session_tasks_length: Array.isArray(writeback.next_session_tasks) ? writeback.next_session_tasks.length : null,
      carry_forward_context_present: typeof writeback.carry_forward_context === 'string' && writeback.carry_forward_context.length > 0,
      handoff_prompt_present: typeof writeback.handoff_prompt === 'string' && writeback.handoff_prompt.length > 0,
      raw_keys: Object.keys(writeback ?? {}),
    }, null, 2));

    // ───── Run the existing normalize helpers ────────────────────────────
    const normalizedDecisions = normalizeDecisions(writeback.decisions_made);
    const normalizedFilesCreated = normalizeFiles(writeback.files_created);
    const normalizedFilesModified = normalizeFiles(writeback.files_modified);
    const normalizedBlockers = normalizeBlockers(writeback.blockers_encountered);

    // ───── DIAGNOSTIC CHECKPOINT 2 — post-normalize shapes ───────────────
    // If CP1 showed full arrays but CP2 shows empty, a normalize helper is
    // the silent-drop point. Most likely cause would be a paste artifact
    // in the deployed source (e.g., `[input.map](http://input.map)` from
    // markdown auto-linking) — though that would also throw a syntax error,
    // so this is unlikely. Still useful for definitive ruling.
    console.log('[mcp v3.1-diag] CP2 post-normalize:', JSON.stringify({
      normalizedDecisions_length: normalizedDecisions.length,
      normalizedFilesCreated_length: normalizedFilesCreated.length,
      normalizedFilesModified_length: normalizedFilesModified.length,
      normalizedBlockers_length: normalizedBlockers.length,
      first_decision_title: normalizedDecisions[0]?.title ?? null,
    }, null, 2));

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

    const stringifiedBody = JSON.stringify(payload);

    // ───── DIAGNOSTIC CHECKPOINT 3 — final POST body ─────────────────────
    // If CP2 showed full normalized arrays but CP3 shows lost length or a
    // suspicious byte size, the drop is in JSON.stringify (extremely
    // unlikely but completable for evidentiary cleanliness).
    console.log('[mcp v3.1-diag] CP3 pre-POST payload:', JSON.stringify({
      payload_decisions_made_length: payload.decisions_made.length,
      payload_files_created_length: payload.files_created.length,
      payload_files_modified_length: payload.files_modified.length,
      payload_blockers_encountered_length: payload.blockers_encountered.length,
      payload_next_session_tasks_length: payload.next_session_tasks.length,
      stringified_body_bytes: stringifiedBody.length,
      target_url: `${this.baseUrl}/functions/v1/neuralsync-smart-close`,
    }, null, 2));

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
          body: stringifiedBody,
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
      console.error('[mcp v3.1-diag] Memory write failed:', error);
      return {
        success: false,
        message: `Failed to write session back: ${(error as Error).message}`,
      };
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
              'Authorization': `Bearer ${this.anonKey}`,
              'apikey': this.anonKey,
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
      console.error('[mcp v3.1-diag] Memory stats failed:', error);
      throw new Error(`Failed to get memory stats: ${(error as Error).message}`);
    }
  }
}
