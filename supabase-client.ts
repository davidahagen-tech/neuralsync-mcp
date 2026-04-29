// Supabase client for NeuralSynch Memory Packet system — v3 (S173 P3.5)
//
// CHANGES FROM v2 (S173):
//   1. Embedding provider swapped from OpenAI to Voyage AI per Decision 10.
//      v2 read OPENAI_API_KEY (never set on Deno Deploy), called
//      api.openai.com/v1/embeddings, requested model text-embedding-3-small
//      (1536-dim). With Decision 10 locked since S147 selecting voyage-4-lite,
//      and ns_records.embedding column corrected to vector(1024) in S172,
//      v2 was structurally incapable of returning usable embeddings even if
//      the key had been set — pgvector would reject 1536-dim writes against
//      a vector(1024) column.
//
//      v3 reads VOYAGE_API_KEY_NEURALSYNCH, calls api.voyageai.com/v1/embeddings,
//      requests model voyage-4-lite (1024-dim), and adds input_type='query'
//      per Voyage best practice (queries are optimized differently than
//      indexed documents — voyage-backfill v2 uses input_type='document'
//      for the document side; this client uses 'query' for the search side).
//
//   2. Added 1024-dim shape validation before caching. Per Decision 12
//      (schema reality beats decision aspiration), validate that what the
//      embedding API returns matches the column type the database enforces.
//      If a future drift slips in, it gets caught at the cache boundary
//      with a clear log line, not at the pgvector boundary as a cryptic
//      RPC error.
//
//   3. Comment header updated to reflect v3 state. Cache structure (Map,
//      5-min TTL, query-keyed) preserved verbatim. Graceful degradation
//      pattern preserved (null embedding → FTS-only ranking).
//
// CHANGES FROM v1 (preserved from v2):
//   1. searchMemory() — was: ilike substring match against non-existent
//      ns_memory_records table. Now: search_ns_records_hybrid() RPC against
//      the typed substrate, with optional content_type/domain filters and
//      cached vector embeddings for hybrid FTS+vector ranking.
//   2. writeSessionBack() — was: POST to /write-session-back- (orphan 404,
//      never deployed). Now: POST to /neuralsync-smart-close (canonical write
//      path shipped in P3). Translates the v1 SessionWriteback shape into
//      smart-close v2 structured-mode input.
//   3. getMemoryStats() — was: counted non-existent ns_memory_records. Now:
//      counts ns_records.
//   4. Embedding cache — module-level Map<query, {embedding, expires}> with
//      5-min TTL. Graceful degradation to FTS-only when API key is unset
//      on Deno Deploy.

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
// Lives across requests on a warm Deno Deploy worker. Recomputed on cold
// start. Bounded by entry expiry, not entry count — for the expected
// query volume this is fine.

const EMBED_CACHE = new Map<string, { embedding: number[]; expires: number }>();
const EMBED_TTL_MS = 5 * 60 * 1000;

// ─── Voyage AI configuration (S173 — Decision 10 alignment) ─────────────
const VOYAGE_API_URL    = 'https://api.voyageai.com/v1/embeddings';
const VOYAGE_MODEL      = 'voyage-4-lite';
const VOYAGE_INPUT_TYPE = 'query';   // queries optimized differently than documents
const VOYAGE_DIM        = 1024;      // matches ns_records.embedding column type post-S172

async function getCachedEmbedding(query: string): Promise<number[] | null> {
  const apiKey = Deno.env.get('VOYAGE_API_KEY_NEURALSYNCH');
  if (!apiKey) {
    // Graceful degradation: no key → no vector → FTS-only ranking.
    return null;
  }

  const now = Date.now();

  // Cache hit
  const cached = EMBED_CACHE.get(query);
  if (cached && cached.expires > now) {
    return cached.embedding;
  }

  // Cache miss — fetch and store
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
      console.error(`[mcp v3] Voyage embedding ${res.status}: ${await res.text()}`);
      return null;
    }

    const data = await res.json();
    const embedding = data?.data?.[0]?.embedding;
    if (!Array.isArray(embedding)) {
      console.error('[mcp v3] Voyage embedding response missing data[0].embedding');
      return null;
    }

    // Decision 12 enforcement: validate dimension at the cache boundary so a
    // future drift gets caught here with a clear log line, not at the
    // pgvector boundary as a cryptic RPC error.
    if (embedding.length !== VOYAGE_DIM) {
      console.error(
        `[mcp v3] Voyage embedding dimension mismatch: expected ${VOYAGE_DIM}, ` +
        `got ${embedding.length}. Wrong model string? Falling back to FTS-only.`,
      );
      return null;
    }

    EMBED_CACHE.set(query, { embedding, expires: now + EMBED_TTL_MS });
    return embedding;
  } catch (err) {
    console.error(`[mcp v3] Voyage embedding error: ${(err as Error).message}`);
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
  // retrieve-context-packet v2 (P1 deliverable) is backward compatible with
  // v1 callers; same GET, same response shape. New POST mode with
  // query_embedding is opt-in and not used here.

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
      console.error('[mcp v3] Memory read failed:', error);
      throw new Error(`Failed to read memory packet: ${(error as Error).message}`);
    }
  }

  // ─── Hybrid search (replaces v1 searchMemory) ────────────────────────
  // Calls search_ns_records_hybrid() RPC — combines tsvector FTS with
  // pgvector cosine similarity. If embedding is null (no API key or fetch
  // failed), the RPC falls back to FTS-only ranking.
  //
  // RPC param assumption: only the three documented params are passed.
  // content_type and domain filters are applied client-side after the RPC
  // returns to avoid coupling to a param naming we haven't verified.

  async searchRecordsHybrid(
    query: string,
    clientId: string = 'viralbrain',
    limit: number = 10,
    filters: SearchFilters = {},
  ): Promise<{ results: any[]; mode: string }> {
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

      return {
        results: results.slice(0, Math.max(1, Math.min(limit, 50))),
        mode: embedding ? 'hybrid' : 'fts_only',
      };
    } catch (error) {
      console.error('[mcp v3] Hybrid search failed:', error);
      throw new Error(`Failed to search ns_records: ${(error as Error).message}`);
    }
  }

  // ─── Session writeback (replaces v1 writeSessionBack) ────────────────
  // Was pointing at orphan 404 endpoint. Now POSTs to neuralsync-smart-close
  // (P3 canonical write path), translating v1 SessionWriteback shape into
  // smart-close v2 structured-mode input shape.

  async writeSessionBack(
    writeback: SessionWriteback,
  ): Promise<{ success: boolean; message: string; details?: any }> {
    const payload = {
      client_id: writeback.client_id,
      session_number: writeback.session_number,
      objective: writeback.objective,
      outcome_summary: writeback.outcome_summary,
      decisions_made: normalizeDecisions(writeback.decisions_made),
      files_created: normalizeFiles(writeback.files_created),
      files_modified: normalizeFiles(writeback.files_modified),
      blockers_encountered: normalizeBlockers(writeback.blockers_encountered),
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
      console.error('[mcp v3] Memory write failed:', error);
      return {
        success: false,
        message: `Failed to write session back: ${(error as Error).message}`,
      };
    }
  }

  // ─── Memory stats (fixed table reference) ────────────────────────────
  // Was counting non-existent ns_memory_records. Now counts ns_records.
  // memory_records key in response preserved for back-compat.

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
        memory_records: counts[1] ?? 0,        // legacy alias for ns_records
        ns_records: counts[1] ?? 0,            // explicit new name
        session_writebacks: counts[2] ?? 0,
        client_id: clientId,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('[mcp v3] Memory stats failed:', error);
      throw new Error(`Failed to get memory stats: ${(error as Error).message}`);
    }
  }
}
