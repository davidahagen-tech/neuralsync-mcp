// Memory Packet tool handlers for MCP protocol — v2.3 (S250 recall + retrieval)
// Maps MCP tool calls to NeuralSynch Memory Packet operations.
//
// CHANGES FROM v2.2 (S250 recall + retrieval — ADDITIVE):
//   1. SIX new read-only tools, all client_id-injected server-side
//      (default 'viralbrain'; never required from the model):
//        - memory_recall          → client.recallMemory (synthesizing recall,
//                                    mirrors direct-path neuralsync-query)
//        - memory_get_recent      → RPC ns_get_recent
//        - memory_get_latest_session → RPC ns_get_latest_session
//        - memory_get_by_session  → RPC ns_get_by_session
//        - memory_filter          → RPC ns_filter_records
//        - memory_current_session → RPC ns_current_session (bigint)
//      Each adds a dispatch case in handleToolCall, a private handler, and a
//      MEMORY_TOOLS_SCHEMA entry. No existing tool, handler, or schema is
//      altered.
//   2. memory_recall returns { answer, citations, sources }; citations mirror
//      the field just added to neuralsync-query:
//      { id, title, content_type, domain, session_number, match_source, score }.
//   3. Object/array-of-object params on the new schemas (memory_filter.tags,
//      memory_filter.attributes) follow the v2.2 explicit-shape rule:
//      explicit properties/items + additionalProperties so strict validators
//      (Anthropic) do not silently strip them.
//
// CHANGES FROM v2.1 (S187 substrate-hygiene, preserved):
//   1. MEMORY_TOOLS_SCHEMA.memory_write — fixes the cross-client schema
//      compatibility bug that caused all five structured array fields
//      (decisions_made, files_created, files_modified, blockers_encountered,
//      next_session_tasks) to be silently stripped by the Anthropic MCP
//      client framework before the JSON-RPC request reached the server.
//
//      Root cause: items were declared as bare `{ type: 'object' }` with
//      no `properties` and no `additionalProperties` directive. ChatGPT's
//      validator treated this as "any object" (per JSON Schema spec) and
//      forwarded the array intact. Anthropic's validator treated it as
//      ambiguous-or-empty-object and dropped the field entirely from
//      outbound payloads.
//
//      Diagnosis confirmed by S187 CP0 log on neuralsync-mcp showing
//      `args_keys: ["client_id", "objective", "outcome_summary",
//      "session_number"]` — only the fully-typed scalar fields survived.
//
//      Fix: each array's items now declare:
//        - explicit `properties` for the documented fields
//        - explicit `required` for the conceptually mandatory subset
//        - `additionalProperties: true` for forward-compat
//      The combination satisfies strict validators (Anthropic) without
//      breaking lenient ones (ChatGPT).
//
//   2. No functional code changes. handleMemoryWrite still reads
//      args.decisions_made etc. unchanged. The fix is schema-only.
//
// CHANGES FROM v2 (S174 Task 4, preserved):
//   1. handleMemorySearch surfaces ordinal-lookup observability fields
//      from supabase-client v3.1: ordinal_match (top-level), and
//      match_source / combined_score / decision_ordinal (per-result).
//   2. handleSearchWrapper UNCHANGED — Deep Research consumers don't
//      surface match_source. Future enhancement, not S174 scope.
//
// CHANGES FROM v1 (preserved):
//   1. memory_search / search — surface new typed-substrate fields
//      (title, content_type, domain, similarity, status). Accept new
//      optional filter params: content_type, domain. Results come from
//      the hybrid FTS+vector RPC instead of ilike substring match.
//   2. memory_write — schema declares the array fields it has always
//      silently accepted (decisions_made, files_created, files_modified,
//      blockers_encountered, next_session_tasks, handoff_prompt, etc.).
//      Body translates to smart-close v2 structured-mode input.
//   3. Search wrapper — uses real r.title field, points url at ns_records.
//   4. Stats — surfaces ns_records count alongside legacy memory_records.

import { NeuralSynchClient, type SessionWriteback } from './supabase-client.ts';
import { CustodyToolHandler, CUSTODY_TOOLS_SCHEMA } from './custody-tools.ts';

// Canonical UUID shape. Used to tell an ns_records record id apart from a
// client_id in the `fetch` tool. Anchored at both ends — a client_id that
// merely contains a UUID is not a record id.
const RECORD_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `id` is an ns_records record UUID rather than a client_id. */
export function isRecordId(id: unknown): boolean {
  return typeof id === 'string' && RECORD_ID_RE.test(id.trim());
}

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
  private custody: CustodyToolHandler;

  constructor() {
    this.client = new NeuralSynchClient();
    this.custody = new CustodyToolHandler();
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
        case 'memory_recall':
          return await this.handleMemoryRecall(tool.arguments);
        case 'memory_get_recent':
          return await this.handleMemoryGetRecent(tool.arguments);
        case 'memory_get_latest_session':
          return await this.handleMemoryGetLatestSession(tool.arguments);
        case 'memory_get_by_session':
          return await this.handleMemoryGetBySession(tool.arguments);
        case 'memory_filter':
          return await this.handleMemoryFilter(tool.arguments);
        case 'memory_current_session':
          return await this.handleMemoryCurrentSession(tool.arguments);
        case 'search':
          return await this.handleSearchWrapper(tool.arguments);
        case 'fetch':
          return await this.handleFetchWrapper(tool.arguments);
        // ─── S251 additive: full-record retrieval ───────────────────────
        case 'get_record_by_id':
          return await this.handleGetRecordById(tool.arguments);
        // ─── S251 additive: artifact custody surface ────────────────────
        case 'custody_resolve_alias':
          return await this.custody.handleResolveAlias(tool.arguments);
        case 'custody_get_metadata':
          return await this.custody.handleGetMetadata(tool.arguments);
        case 'custody_retrieve':
          return await this.custody.handleRetrieve(tool.arguments);
        case 'custody_verify':
          return await this.custody.handleVerify(tool.arguments);
        // ─── S252 additive: governed custody writes + extended reads ────
        case 'custody_store':
          return await this.custody.handleStore(tool.arguments);
        case 'custody_begin_upload':
          return await this.custody.handleBeginUpload(tool.arguments);
        case 'custody_finalize_upload':
          return await this.custody.handleFinalizeUpload(tool.arguments);
        case 'custody_set_alias':
          return await this.custody.handleSetAlias(tool.arguments);
        case 'custody_list_versions':
          return await this.custody.handleListVersions(tool.arguments);
        case 'custody_add_dependency':
          return await this.custody.handleAddDependency(tool.arguments);
        case 'custody_dependency_closure':
          return await this.custody.handleDependencyClosure(tool.arguments);
        case 'custody_export_session':
          return await this.custody.handleExportSession(tool.arguments);
        case 'custody_scan_archive':
          return await this.custody.handleScanArchive(tool.arguments);
        case 'custody_report_missing':
          return await this.custody.handleReportMissing(tool.arguments);
        default:
          throw new Error(`Unknown tool: ${tool.name}`);
      }
    } catch (error) {
      console.error(`[mcp v2.3] Tool execution failed for ${tool.name}:`, error);
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

    const { results, mode, ordinal_match } = await this.client.searchRecordsHybrid(query, clientId, limit, filters);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          search_query: query,
          search_mode: mode,
          ordinal_match,
          filters,
          results_count: results.length,
          client_id: clientId,
          results: results.map((r: any) => {
            const body = typeof r.body === 'string' ? r.body : '';
            const truncated = body.length > 200 ? body.substring(0, 200) + '...' : body;
            return {
              id: r.id,
              title: r.title,
              record_type: r.content_type,
              content_type: r.content_type,
              domain: r.domain,
              status: r.status,
              similarity: r.similarity ?? r.rank ?? null,
              content: truncated,
              body: truncated,
              session_number: r.session_number,
              source_session: r.source_session,
              created_at: r.created_at,
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
            memory_records: stats.memory_records,
            ns_records: stats.ns_records,
            session_writebacks: stats.session_writebacks,
            total_artifacts: stats.locked_decisions + stats.ns_records + stats.session_writebacks,
          },
          timestamp: stats.timestamp,
          anti_amnesia_status: stats.locked_decisions > 0 ? 'active' : 'initializing',
        }, null, 2),
      }],
    };
  }

  // ─── memory_recall v2.3 — synthesizing recall (mirrors neuralsync-query) ──

  private async handleMemoryRecall(args: any): Promise<MCPToolResult> {
    const question = args.question;
    if (!question) {
      throw new Error('Question parameter is required for memory recall');
    }

    const clientId = args.client_id || 'viralbrain';
    const { answer, citations, sources } = await this.client.recallMemory(question, clientId);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          question,
          client_id: clientId,
          answer,
          citations,
          sources,
        }, null, 2),
      }],
    };
  }

  // ─── memory_get_recent v2.3 — ns_get_recent ──────────────────────────

  private async handleMemoryGetRecent(args: any): Promise<MCPToolResult> {
    const clientId = args.client_id || 'viralbrain';
    const records = await this.client.getRecent(clientId, {
      content_type: typeof args.content_type === 'string' ? args.content_type : undefined,
      domain: typeof args.domain === 'string' ? args.domain : undefined,
      since: typeof args.since === 'string' ? args.since : undefined,
      limit: typeof args.limit === 'number' ? args.limit : undefined,
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          client_id: clientId,
          results_count: Array.isArray(records) ? records.length : 0,
          results: records,
        }, null, 2),
      }],
    };
  }

  // ─── memory_get_latest_session v2.3 — ns_get_latest_session ──────────

  private async handleMemoryGetLatestSession(args: any): Promise<MCPToolResult> {
    const clientId = args.client_id || 'viralbrain';
    const records = await this.client.getLatestSession(clientId);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          client_id: clientId,
          results: records,
        }, null, 2),
      }],
    };
  }

  // ─── memory_get_by_session v2.3 — ns_get_by_session ──────────────────

  private async handleMemoryGetBySession(args: any): Promise<MCPToolResult> {
    const sessionNumber = args.session_number;
    if (sessionNumber === undefined || sessionNumber === null) {
      throw new Error('session_number parameter is required for memory_get_by_session');
    }

    const clientId = args.client_id || 'viralbrain';
    const records = await this.client.getBySession(clientId, sessionNumber);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          client_id: clientId,
          session_number: sessionNumber,
          results_count: Array.isArray(records) ? records.length : 0,
          results: records,
        }, null, 2),
      }],
    };
  }

  // ─── memory_filter v2.3 — ns_filter_records ──────────────────────────

  private async handleMemoryFilter(args: any): Promise<MCPToolResult> {
    const clientId = args.client_id || 'viralbrain';
    const records = await this.client.filterRecords(clientId, {
      content_type: typeof args.content_type === 'string' ? args.content_type : undefined,
      domain: typeof args.domain === 'string' ? args.domain : undefined,
      status: typeof args.status === 'string' ? args.status : undefined,
      tags: Array.isArray(args.tags) ? args.tags : undefined,
      attributes: args.attributes && typeof args.attributes === 'object' ? args.attributes : undefined,
      title_ilike: typeof args.title_ilike === 'string' ? args.title_ilike : undefined,
      body_ilike: typeof args.body_ilike === 'string' ? args.body_ilike : undefined,
      since: typeof args.since === 'string' ? args.since : undefined,
      until: typeof args.until === 'string' ? args.until : undefined,
      order: typeof args.order === 'string' ? args.order : undefined,
      limit: typeof args.limit === 'number' ? args.limit : undefined,
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          client_id: clientId,
          results_count: Array.isArray(records) ? records.length : 0,
          results: records,
        }, null, 2),
      }],
    };
  }

  // ─── memory_current_session v2.3 — ns_current_session (bigint) ───────

  private async handleMemoryCurrentSession(args: any): Promise<MCPToolResult> {
    const clientId = args.client_id || 'viralbrain';
    const sessionNumber = await this.client.currentSession(clientId);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          client_id: clientId,
          current_session: sessionNumber,
        }, null, 2),
      }],
    };
  }

  // ─── ChatGPT compat: search ──────────────────────────────────────────

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

  // ─── S251 additive: get_record_by_id ─────────────────────────────────
  //
  // Returns ONE complete ns_records row including the full body. `search`
  // returns record ids; before this there was no tool that could turn one of
  // those ids back into the whole document.

  private async handleGetRecordById(args: any): Promise<MCPToolResult> {
    const recordId = typeof args?.record_id === 'string' ? args.record_id.trim() : '';
    if (!recordId) {
      throw new Error('record_id is required for get_record_by_id');
    }
    if (!isRecordId(recordId)) {
      throw new Error(
        `record_id must be an ns_records UUID; received "${recordId}". ` +
          'If you meant to read a client memory packet, call memory_read with client_id instead.',
      );
    }

    const record = await this.client.getRecordById(recordId);

    if (!record) {
      // Fail closed and say so plainly. Returning an empty-looking success here
      // is the exact defect this tool exists to remove.
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            found: false,
            record_id: recordId,
            error: 'RECORD_NOT_FOUND',
            detail:
              `No ns_records row exists with id ${recordId}. This is a definitive negative, not an empty substrate.`,
          }, null, 2),
        }],
        isError: true,
      };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          found: true,
          id: record.id,
          title: record.title,
          content_type: record.content_type,
          domain: record.domain,
          status: record.status,
          session_number: record.session_number,
          client_id: record.client_id,
          tags: record.tags,
          attributes: record.attributes,
          created_at: record.created_at,
          body: record.body,
          truncated: false,
        }, null, 2),
      }],
    };
  }

  // ─── ChatGPT compat: fetch ───────────────────────────────────────────
  //
  // S251 CORRECTION. Previously this treated `args.id` as a client_id
  // unconditionally. Given a real ns_records UUID it found no such client and
  // returned a confident, well-formatted, EMPTY packet ("No locked decisions
  // found", "No active records in ns_records yet") with no error — it failed
  // OPEN. A Master AI asking for a known-good record was told the substrate was
  // empty. Deep Research convention is that `search` returns ids and `fetch`
  // retrieves that document, so a UUID must resolve to a record.
  //
  // Behaviour now:
  //   id is a UUID      → return that ns_records record (or RECORD_NOT_FOUND)
  //   id is anything else → original client_id memory-packet behaviour, unchanged

  private async handleFetchWrapper(args: any): Promise<MCPToolResult> {
    if (isRecordId(args?.id)) {
      return await this.handleGetRecordById({ record_id: String(args.id).trim() });
    }

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
// MCP DISCOVERY SCHEMAS — v2.2 fix: explicit item shapes for arrays
// ═══════════════════════════════════════════════════════════════════════
// readOnlyHint on each read-only tool prevents unnecessary confirmation
// modals in ChatGPT. memory_write is the only tool that mutates state.
//
// NOTE: Required fields go in the parent `required: [...]` array per JSON
// Schema draft 7+. Do NOT put `required: true` on individual property defs
// — ChatGPT's strict schema validator rejects it.
//
// v2.2 FIX: All five array-of-object fields on memory_write now declare:
//   - explicit `properties` for documented fields
//   - explicit `required` array (where applicable) for conceptually
//     mandatory subset
//   - `additionalProperties: true` for forward-compat
// This satisfies Anthropic's strict outbound validator without breaking
// ChatGPT's lenient one. Bare `items: { type: 'object' }` (the v2.1
// shape) caused Anthropic to silently strip these arrays from outbound
// JSON-RPC payloads.
//
// v2.3 NOTE: the six new read-only tools (memory_recall, memory_get_recent,
// memory_get_latest_session, memory_get_by_session, memory_filter,
// memory_current_session) follow the same rule. Every object/array-of-object
// param (memory_filter.tags, memory_filter.attributes) carries explicit
// items/properties + additionalProperties so strict validators do not strip
// them. client_id is injected server-side and is NEVER in any `required`.

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
          description: 'Locked decisions reached this session.',
          items: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'Short decision title (becomes decision_title in ns_locked_decisions; unique per client_id)',
              },
              rationale: {
                type: 'string',
                description: 'Why this decision was made; long-form supported',
              },
              decision_type: {
                type: 'string',
                description: 'Optional category (e.g. technical, product_framing, architectural_discovery, implementation, session_close, data_calibration, diagnostic)',
              },
              priority: {
                type: 'number',
                description: 'Optional priority 0-9 (lower=higher priority; default 5)',
              },
              confidence_score: {
                type: 'number',
                description: 'Optional confidence 0.0-1.0 decimal (default 0.95)',
              },
              platform: {
                type: 'string',
                description: 'Optional platform tag (e.g. farsight, neuralsynch, cross-platform)',
              },
            },
            required: ['title', 'rationale'],
            additionalProperties: true,
          },
        },
        files_created: {
          type: 'array',
          description: 'New files created this session.',
          items: {
            type: 'object',
            properties: {
              file_path: {
                type: 'string',
                description: 'File path',
              },
              description: {
                type: 'string',
                description: 'Optional description of what the file does',
              },
              language: {
                type: 'string',
                description: 'Optional language (typescript, python, sql, markdown, etc.)',
              },
            },
            required: ['file_path'],
            additionalProperties: true,
          },
        },
        files_modified: {
          type: 'array',
          description: 'Existing files modified this session.',
          items: {
            type: 'object',
            properties: {
              file_path: {
                type: 'string',
                description: 'File path',
              },
              description: {
                type: 'string',
                description: 'Optional description of changes',
              },
              language: {
                type: 'string',
                description: 'Optional language',
              },
            },
            required: ['file_path'],
            additionalProperties: true,
          },
        },
        blockers_encountered: {
          type: 'array',
          description: 'Errors or blockers hit this session.',
          items: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'Short blocker title',
              },
              description: {
                type: 'string',
                description: 'Detailed description of the blocker',
              },
              status: {
                type: 'string',
                description: 'Optional status (canonical: active, open, resolved, deprecated, superseded, recurring; common variants pending/failed/blocked/in_progress/closed/archived are normalized server-side)',
              },
              error_type: {
                type: 'string',
                description: 'Optional category (e.g. validation, api, infrastructure, schema, transport)',
              },
            },
            required: ['title', 'description'],
            additionalProperties: true,
          },
        },
        next_session_tasks: {
          type: 'array',
          description: 'Carry-forward tasks for the next session. Free-form objects.',
          items: {
            type: 'object',
            additionalProperties: true,
          },
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
  // ─── S250 recall + retrieval tools (read-only, client_id server-injected) ──
  {
    name: 'memory_recall',
    description: 'Synthesizing recall over the typed memory substrate (ns_records). Embeds the question (Voyage voyage-4-lite, FTS fallback), runs the recency-aware hybrid RPC, and synthesizes an answer (Anthropic Haiku) strictly from the returned records. Returns { answer, citations, sources }; answers "This is not yet in your IP store." when the substrate has no match. Mirrors the direct-path neuralsync-query function for cross-path parity.',
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'Natural-language question to answer from NeuralSynch memory.',
        },
        client_id: {
          type: 'string',
          description: 'Client identifier (default: viralbrain)',
          default: 'viralbrain',
        },
      },
      required: ['question'],
    },
  },
  {
    name: 'memory_get_recent',
    description: 'Get the most recent typed memory records (ns_records) for the client, newest first. Optional filters narrow to a content_type, domain, or records since a timestamp.',
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        content_type: {
          type: 'string',
          description: 'Filter to one content type (optional). E.g. decision, session_writeback, code_artifact, error, runbook.',
        },
        domain: {
          type: 'string',
          description: 'Filter to one domain (optional). E.g. neuralsynch.memory-architecture, farsight.predict.',
        },
        since: {
          type: 'string',
          description: 'ISO 8601 timestamp; only records created at or after this time (optional).',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of records (default: 20).',
          default: 20,
        },
        client_id: {
          type: 'string',
          description: 'Client identifier (default: viralbrain)',
          default: 'viralbrain',
        },
      },
    },
  },
  {
    name: 'memory_get_latest_session',
    description: 'Get the latest session row for the client (highest session number, active by default).',
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
  {
    name: 'memory_get_by_session',
    description: 'Get all typed memory records (ns_records) attached to a specific session number for the client.',
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        session_number: {
          type: 'number',
          description: 'Session number to retrieve records for.',
        },
        client_id: {
          type: 'string',
          description: 'Client identifier (default: viralbrain)',
          default: 'viralbrain',
        },
      },
      required: ['session_number'],
    },
  },
  {
    name: 'memory_filter',
    description: 'Structured filter over typed memory records (ns_records). Combine content_type, domain, status, tags, JSON attributes, title/body ILIKE substrings, and a created-at window, then order and limit. All filters are optional.',
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        content_type: {
          type: 'string',
          description: 'Filter to one content type (optional).',
        },
        domain: {
          type: 'string',
          description: 'Filter to one domain (optional).',
        },
        status: {
          type: 'string',
          description: 'Filter to one status (optional). E.g. active, resolved, deprecated, superseded.',
        },
        tags: {
          type: 'array',
          description: 'Filter to records carrying all of these tags (optional).',
          items: {
            type: 'string',
          },
        },
        attributes: {
          type: 'object',
          description: 'Filter by JSON attributes (optional). Free-form key/value object matched against the record attributes column.',
          additionalProperties: true,
        },
        title_ilike: {
          type: 'string',
          description: 'Case-insensitive substring match against the record title (optional). Plain substring; no % wildcards needed.',
        },
        body_ilike: {
          type: 'string',
          description: 'Case-insensitive substring match against the record body (optional).',
        },
        since: {
          type: 'string',
          description: 'ISO 8601 timestamp; only records created at or after this time (optional).',
        },
        until: {
          type: 'string',
          description: 'ISO 8601 timestamp; only records created at or before this time (optional).',
        },
        order: {
          type: 'string',
          description: 'Ordering hint (optional). E.g. created_at.desc, created_at.asc.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of records (optional).',
        },
        client_id: {
          type: 'string',
          description: 'Client identifier (default: viralbrain)',
          default: 'viralbrain',
        },
      },
    },
  },
  {
    name: 'memory_current_session',
    description: 'Get the current session number (bigint) for the client.',
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

// ═══════════════════════════════════════════════════════════════════════
// S251 ADDITIVE SCHEMAS
// ═══════════════════════════════════════════════════════════════════════
// MEMORY_TOOLS_SCHEMA above is left byte-for-byte unchanged so the original
// twelve tools are provably untouched. New tools are declared in separate
// arrays and joined into ALL_TOOLS_SCHEMA, which is what the server advertises.

export const RECORD_TOOLS_SCHEMA = [
  {
    name: 'get_record_by_id',
    description:
      'Retrieve ONE complete NeuralSynch memory record (ns_records) by its record UUID, including the FULL body — not an excerpt and not a summary. Use this after `search` returns a record id and you need the whole document, for example an operating runbook. Returns a definitive RECORD_NOT_FOUND error if the id does not exist, never an empty-looking success.',
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        record_id: {
          type: 'string',
          description: 'ns_records record UUID (as returned in the id field by `search`)',
        },
      },
      required: ['record_id'],
    },
  },
];

/**
 * The complete advertised tool surface: the original 12 memory tools, plus
 * full-record retrieval, plus the 14 artifact-custody tools (4 read-only from
 * S251, 8 governed write/read tools from S252 and 2 direct-upload tools). 27 total.
 */
export const ALL_TOOLS_SCHEMA = [
  ...MEMORY_TOOLS_SCHEMA,
  ...RECORD_TOOLS_SCHEMA,
  ...CUSTODY_TOOLS_SCHEMA,
];
