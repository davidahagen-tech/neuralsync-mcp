// Memory Packet tool handlers for MCP protocol — v2.1 (S174 Task 4)
// Maps MCP tool calls to NeuralSynch Memory Packet operations.
//
// CHANGES FROM v2 (S174 Task 4):
//   1. handleMemorySearch surfaces ordinal-lookup observability fields
//      from supabase-client v3.1: ordinal_match (top-level), and
//      match_source / combined_score / decision_ordinal (per-result).
//      Without these, ordinal lookup would work invisibly — the MCP
//      response would not show whether the ordinal branch fired.
//   2. handleSearchWrapper UNCHANGED — Deep Research consumers don't
//      surface match_source. Future enhancement, not S174 scope.
//   3. MEMORY_TOOLS_SCHEMA UNCHANGED — additive response fields don't
//      need schema changes.
//
// CHANGES FROM v1 (preserved through v2 and v2.1):
//   1. memory_search / search — surface new typed-substrate fields
//      (title, content_type, domain, similarity, status). Accept new
//      optional filter params: content_type, domain. Results come from
//      the hybrid FTS+vector RPC instead of ilike substring match.
//   2. memory_write — schema now declares the array fields it has always
//      silently accepted (decisions_made, files_created, files_modified,
//      blockers_encountered, next_session_tasks, handoff_prompt, etc.).
//      Body translates to smart-close v2 structured-mode input.
//   3. Search wrapper — uses real r.title field, points url at ns_records.
//   4. Stats — surfaces ns_records count alongside legacy memory_records.

import { NeuralSynchClient, type SessionWriteback } from './supabase-client.ts';

export interface MCPToolCall {
  name: string;
  arguments: Record<string, any>;
}

export interface MCPToolResult {
  content: Array<{
    type: 'text';
    text: string;
  }>;
  isError?: boolean;
}

export class MemoryToolHandler {
  private client: NeuralSynchClient;

  constructor() {
    this.client = new NeuralSynchClient();
  }

  async handleToolCall(tool: MCPToolCall): Promise<MCPToolResult> {
    try {
      switch (tool.name) {
        case 'memory_read':
          return await this.handleMemoryRead(tool.arguments);
        case 'memory_write':
          return await this.handleMemoryWrite(tool.arguments);
        case 'memory_search':
          return await this.handleMemorySearch(tool.arguments);
        case 'memory_stats':
          return await this.handleMemoryStats(tool.arguments);
        case 'search':
          return await this.handleSearchWrapper(tool.arguments);
        case 'fetch':
          return await this.handleFetchWrapper(tool.arguments);
        default:
          throw new Error(`Unknown tool: ${tool.name}`);
      }
    } catch (error) {
      console.error(`[mcp v2.1] Tool execution failed for ${tool.name}:`, error);
      return {
        content: [{
          type: 'text',
          text: `Error executing ${tool.name}: ${(error as Error).message}`,
        }],
        isError: true,
      };
    }
  }

  // ─── memory_read ─────────────────────────────────────────────────────

  private async handleMemoryRead(args: any): Promise<MCPToolResult> {
    const clientId = args.client_id || 'viralbrain';
    const context = await this.client.readMemoryPacket(clientId);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: context.success,
          memory_loaded: true,
          client_id: context.client_id,
          session_number: context.session_number,
          locked_decisions: context.locked_decisions_count,
          memory_records: context.memory_records_count,
          anti_amnesia_status: context.anti_amnesia_status,
          context_prompt: context.context_prompt,
        }, null, 2),
      }],
    };
  }

  // ─── memory_write ────────────────────────────────────────────────────

  private async handleMemoryWrite(args: any): Promise<MCPToolResult> {
    const writeback: SessionWriteback = {
      session_number: args.session_number || Date.now(),
      client_id: args.client_id || 'viralbrain',
      objective: args.objective || 'No objective specified',
      outcome_summary: args.outcome_summary || 'No summary provided',
      files_created: args.files_created || [],
      files_modified: args.files_modified || [],
      decisions_made: args.decisions_made || [],
      blockers_encountered: args.blockers_encountered || [],
      next_session_tasks: args.next_session_tasks || [],
      handoff_prompt: args.handoff_prompt,
      carry_forward_context: args.carry_forward_context,
      bolt_project: args.bolt_project,
      platform_state: args.platform_state,
    };

    const result = await this.client.writeSessionBack(writeback);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: result.success,
          message: result.message,
          session_captured: result.success,
          writeback_data: {
            session_number: writeback.session_number,
            client_id: writeback.client_id,
            decisions_count: writeback.decisions_made?.length ?? 0,
            files_created_count: writeback.files_created?.length ?? 0,
            files_modified_count: writeback.files_modified?.length ?? 0,
            blockers_count: writeback.blockers_encountered?.length ?? 0,
            tasks_count: writeback.next_session_tasks?.length ?? 0,
          },
          smart_close_response: result.details ?? null,
        }, null, 2),
      }],
      isError: !result.success,
    };
  }

  // ─── memory_search v2.1 — surfaces ordinal-lookup observability ─────
  // Three additive changes from v2:
  //   1. Destructure ordinal_match from searchRecordsHybrid return.
  //   2. Surface ordinal_match in the JSON response object.
  //   3. Surface match_source / combined_score / decision_ordinal in
  //      the per-result map (undefined for non-ordinal hits — JSON
  //      stringify drops undefined properties).

  private async handleMemorySearch(args: any): Promise<MCPToolResult> {
    const query = args.query;
    if (!query) {
      throw new Error('Query parameter is required for memory search');
    }

    const clientId = args.client_id || 'viralbrain';
    const limit = args.limit || 10;
    const filters = {
      content_type: typeof args.content_type === 'string' ? args.content_type : undefined,
      domain: typeof args.domain === 'string' ? args.domain : undefined,
    };

    // CHANGE 1: destructure ordinal_match from v3.1 return shape
    const { results, mode, ordinal_match } = await this.client.searchRecordsHybrid(query, clientId, limit, filters);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          search_query: query,
          search_mode: mode, // "hybrid" or "fts_only"
          ordinal_match,     // CHANGE 2: surface ordinal-lookup signal in response
          filters,
          results_count: results.length,
          client_id: clientId,
          results: results.map((r: any) => {
            const body = typeof r.body === 'string' ? r.body : '';
            const truncated = body.length > 200 ? body.substring(0, 200) + '...' : body;
            return {
              id: r.id,
              title: r.title,
              record_type: r.content_type,    // legacy alias preserved
              content_type: r.content_type,
              domain: r.domain,
              status: r.status,
              similarity: r.similarity ?? r.rank ?? null,
              content: truncated,             // legacy alias preserved
              body: truncated,
              session_number: r.session_number,
              source_session: r.source_session,
              created_at: r.created_at,
              // CHANGE 3: surface ordinal-lookup fields when present
              // (undefined for hybrid hits — JSON.stringify omits undefined)
              match_source: r.match_source ?? undefined,
              combined_score: r.combined_score ?? undefined,
              decision_ordinal: r.decision_ordinal ?? undefined,
            };
          }),
        }, null, 2),
      }],
    };
  }

  // ─── memory_stats ────────────────────────────────────────────────────

  private async handleMemoryStats(args: any): Promise<MCPToolResult> {
    const clientId = args.client_id || 'viralbrain';
    const stats = await this.client.getMemoryStats(clientId);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          client_id: clientId,
          memory_system_health: 'operational',
          statistics: {
            locked_decisions: stats.locked_decisions,
            memory_records: stats.memory_records,        // legacy alias
            ns_records: stats.ns_records,                // explicit new name
            session_writebacks: stats.session_writebacks,
            total_artifacts: stats.locked_decisions + stats.ns_records + stats.session_writebacks,
          },
          timestamp: stats.timestamp,
          anti_amnesia_status: stats.locked_decisions > 0 ? 'active' : 'initializing',
        }, null, 2),
      }],
    };
  }

  // ─── ChatGPT compat: search ──────────────────────────────────────────
  // NOT MODIFIED in v2.1 — Deep Research consumers don't surface
  // match_source/combined_score/decision_ordinal. Future enhancement.

  private async handleSearchWrapper(args: any): Promise<MCPToolResult> {
    const query = args.query;
    if (!query) {
      throw new Error('Query parameter is required for search');
    }

    const clientId = args.client_id || 'viralbrain';
    const limit = args.limit || 10;
    const filters = {
      content_type: typeof args.content_type === 'string' ? args.content_type : undefined,
      domain: typeof args.domain === 'string' ? args.domain : undefined,
    };

    const { results } = await this.client.searchRecordsHybrid(query, clientId, limit, filters);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          results: results.map((r: any) => ({
            id: String(r.id),
            title: r.title || `${r.content_type} — ${r.source_session ?? 'unknown'}`,
            text: typeof r.body === 'string' ? r.body : '',
            url: `https://udafklielwqdppnagtwc.supabase.co/rest/v1/ns_records?id=eq.${r.id}`,
          })),
        }, null, 2),
      }],
    };
  }

  // ─── ChatGPT compat: fetch ───────────────────────────────────────────

  private async handleFetchWrapper(args: any): Promise<MCPToolResult> {
    const clientId = args.id || args.client_id || 'viralbrain';
    const context = await this.client.readMemoryPacket(clientId);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          id: clientId,
          title: `NeuralSynch memory packet — ${clientId}`,
          text: context.context_prompt,
          url: `https://udafklielwqdppnagtwc.supabase.co/functions/v1/neuralsync-context`,
          metadata: {
            session_number: context.session_number,
            locked_decisions: context.locked_decisions_count,
            memory_records: context.memory_records_count,
            anti_amnesia_status: context.anti_amnesia_status,
          },
        }, null, 2),
      }],
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// MCP DISCOVERY SCHEMAS — UNCHANGED in v2.1
// ═══════════════════════════════════════════════════════════════════════
// readOnlyHint on each read-only tool prevents unnecessary confirmation
// modals in ChatGPT. memory_write is the only tool that mutates state.
//
// NOTE: Required fields go in the parent `required: [...]` array per JSON
// Schema draft 7+. Do NOT put `required: true` on individual property defs
// — ChatGPT's strict schema validator rejects it.
//
// New optional params in v2 (preserved in v2.1):
//   - memory_search / search: content_type, domain (filter by typed substrate)
//   - memory_write: decisions_made, files_created, files_modified,
//     blockers_encountered, next_session_tasks, handoff_prompt,
//     carry_forward_context, bolt_project, platform_state
//
// Schemas remain JSON-Schema-strict and ChatGPT-compatible.

export const MEMORY_TOOLS_SCHEMA = [
  {
    name: 'memory_read',
    description: 'Retrieve memory packet context for session continuity. Gets latest session writebacks, locked decisions, and memory records.',
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        client_id: {
          type: 'string',
          description: 'Client identifier (default: viralbrain)',
          default: 'viralbrain',
        },
        session_number: {
          type: 'number',
          description: 'Target session number (optional, auto-increments if not provided)',
        },
      },
    },
  },
  {
    name: 'memory_write',
    description: 'Capture session outcomes to Memory Packets via the canonical smart-close write path. Stores session writebacks (ns_session_writebacks), locks critical decisions (ns_locked_decisions), and creates typed memory records (ns_records).',
    annotations: {
      readOnlyHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        client_id: {
          type: 'string',
          description: 'Client identifier (default: viralbrain)',
          default: 'viralbrain',
        },
        session_number: {
          type: 'number',
          description: 'Session number for this writeback',
        },
        objective: {
          type: 'string',
          description: 'Primary objective/goal for this session',
        },
        outcome_summary: {
          type: 'string',
          description: 'Summary of what was accomplished this session',
        },
        decisions_made: {
          type: 'array',
          description: 'Locked decisions reached this session. Each item: { title, rationale, decision_type?, priority?, confidence_score?, platform? }',
          items: { type: 'object' },
        },
        files_created: {
          type: 'array',
          description: 'New files created. Each item: { file_path, description?, language? }',
          items: { type: 'object' },
        },
        files_modified: {
          type: 'array',
          description: 'Existing files modified. Each item: { file_path, description?, language? }',
          items: { type: 'object' },
        },
        blockers_encountered: {
          type: 'array',
          description: 'Errors or blockers hit this session. Each item: { title, description, status?, error_type? }',
          items: { type: 'object' },
        },
        next_session_tasks: {
          type: 'array',
          description: 'Carry-forward tasks for the next session.',
          items: { type: 'object' },
        },
        handoff_prompt: {
          type: 'string',
          description: 'Handoff prompt for the next session (optional)',
        },
        carry_forward_context: {
          type: 'string',
          description: 'Long-form context to carry into the next session (optional)',
        },
        bolt_project: {
          type: 'string',
          description: 'Bolt project ID this session targeted (optional)',
        },
        platform_state: {
          type: 'object',
          description: 'Platform state snapshot (optional). Free-form object.',
        },
      },
      required: ['session_number', 'objective', 'outcome_summary'],
    },
  },
  {
    name: 'memory_search',
    description: 'Hybrid FTS + vector search across the typed memory substrate (ns_records). Combines full-text search with cosine-similarity ranking on embeddings. Optional filters narrow to a specific content_type or domain. v2.1 surfaces ordinal_match for "Decision N" queries.',
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        client_id: {
          type: 'string',
          description: 'Client identifier (default: viralbrain)',
          default: 'viralbrain',
        },
        query: {
          type: 'string',
          description: 'Search query to find relevant memories. Special pattern: "Decision N" triggers fast ordinal lookup before hybrid search.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 10, max: 50)',
          default: 10,
        },
        content_type: {
          type: 'string',
          description: 'Filter to one content type. Valid values: session_writeback, decision, code_artifact, error, schema_snapshot, spec, prompt, runbook, asset_image, asset_chat, prose. Optional.',
        },
        domain: {
          type: 'string',
          description: 'Filter to one domain (e.g. neuralsynch.memory-architecture, farsight.predict, cross-platform). Optional.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_stats',
    description: 'Get memory system statistics and health metrics for the client.',
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        client_id: {
          type: 'string',
          description: 'Client identifier (default: viralbrain)',
          default: 'viralbrain',
        },
      },
    },
  },
  // ─── ChatGPT Deep Research / Company Knowledge compatibility wrappers ──
  {
    name: 'search',
    description: 'Search NeuralSynch memory for records matching a query. Returns a list of matches with id, title, and text content. Compatible with ChatGPT Deep Research conventions.',
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query',
        },
        client_id: {
          type: 'string',
          description: 'Client identifier (default: viralbrain)',
          default: 'viralbrain',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 10)',
          default: 10,
        },
        content_type: {
          type: 'string',
          description: 'Filter to one content type (optional). E.g. decision, session_writeback, code_artifact, error, runbook.',
        },
        domain: {
          type: 'string',
          description: 'Filter to one domain (optional). E.g. neuralsynch.memory-architecture, farsight.predict.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetch',
    description: 'Fetch a single NeuralSynch memory packet by id. Returns the full context including session continuity, locked decisions, and memory records. Compatible with ChatGPT Deep Research conventions.',
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Packet identifier. For NeuralSynch this is the client_id (default: viralbrain).',
        },
      },
      required: ['id'],
    },
  },
];
