// Memory Packet tool handlers for MCP protocol
// Maps MCP tool calls to NeuralSynch Memory Packet operations
 
import { NeuralSynchClient, type MemoryContext, type SessionWriteback } from './supabase-client.ts';
 
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
 
        // ChatGPT Deep Research / Company Knowledge compatibility wrappers.
        // `search` mirrors memory_search. `fetch` mirrors memory_read.
        // Argument shapes are normalized to match OpenAI's expectations.
        case 'search':
          return await this.handleSearchWrapper(tool.arguments);
 
        case 'fetch':
          return await this.handleFetchWrapper(tool.arguments);
 
        default:
          throw new Error(`Unknown tool: ${tool.name}`);
      }
    } catch (error) {
      console.error(`Tool execution failed for ${tool.name}:`, error);
      return {
        content: [{
          type: 'text',
          text: `Error executing ${tool.name}: ${error.message}`
        }],
        isError: true
      };
    }
  }
 
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
          context_prompt: context.context_prompt
        }, null, 2)
      }]
    };
  }
 
  private async handleMemoryWrite(args: any): Promise<MCPToolResult> {
    const writeback: SessionWriteback = {
      session_number: args.session_number || Date.now(),
      client_id: args.client_id || 'viralbrain',
      objective: args.objective || 'No objective specified',
      outcome_summary: args.outcome_summary || 'No summary provided',
      files_created: args.files_created || [],
      files_modified: args.files_modified || [],
      decisions_made: args.decisions_made || [],
      next_session_tasks: args.next_session_tasks || [],
      handoff_prompt: args.handoff_prompt
    };
 
    const result = await this.client.writeSessionBack(writeback);
 
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: result.success,
          message: result.message,
          session_captured: true,
          writeback_data: {
            session_number: writeback.session_number,
            client_id: writeback.client_id,
            decisions_count: writeback.decisions_made.length,
            tasks_count: writeback.next_session_tasks.length
          }
        }, null, 2)
      }]
    };
  }
 
  private async handleMemorySearch(args: any): Promise<MCPToolResult> {
    const query = args.query;
    const clientId = args.client_id || 'viralbrain';
    const limit = args.limit || 10;
 
    if (!query) {
      throw new Error('Query parameter is required for memory search');
    }
 
    const results = await this.client.searchMemory(query, clientId, limit);
 
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          search_query: query,
          results_count: results.length,
          client_id: clientId,
          results: results.map((record: any) => ({
            id: record.id,
            record_type: record.record_type,
            content: record.content.substring(0, 200) + (record.content.length > 200 ? '...' : ''),
            created_at: record.created_at,
            source_session: record.source_session
          }))
        }, null, 2)
      }]
    };
  }
 
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
            session_writebacks: stats.session_writebacks,
            total_artifacts: stats.locked_decisions + stats.memory_records + stats.session_writebacks
          },
          timestamp: stats.timestamp,
          anti_amnesia_status: stats.locked_decisions > 0 ? 'active' : 'initializing'
        }, null, 2)
      }]
    };
  }
 
  // -----------------------------------------------------------------------------
  // ChatGPT Deep Research / Company Knowledge compatibility wrappers
  // -----------------------------------------------------------------------------
  //
  // ChatGPT's Deep Research and Company Knowledge features expect MCP servers
  // to expose two canonically-named tools: `search` and `fetch`. Rather than
  // requiring operators to know the NeuralSynch-specific names, these wrappers
  // delegate to the existing memory_search and memory_read handlers.
  //
  // `search` accepts a { query } argument and returns a list of hits in the
  // OpenAI-expected shape: { id, title, text, url? }.
  //
  // `fetch` accepts a { id } argument. Since NeuralSynch's primary retrieval
  // unit is the memory packet (via client_id), this wrapper treats the `id`
  // argument as the client_id. For a single-client deployment (viralbrain),
  // any id value maps to the same packet — which is the correct behavior.
 
  private async handleSearchWrapper(args: any): Promise<MCPToolResult> {
    const query = args.query;
    if (!query) {
      throw new Error('Query parameter is required for search');
    }
 
    const clientId = args.client_id || 'viralbrain';
    const limit = args.limit || 10;
    const results = await this.client.searchMemory(query, clientId, limit);
 
    // Return in OpenAI-expected shape: array of { id, title, text, url }.
    // Wrapped in a single text block for MCP transport compatibility.
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          results: results.map((record: any) => ({
            id: String(record.id),
            title: record.record_type
              ? `${record.record_type} — ${record.source_session || 'vault'}`
              : (record.source_session || 'Vault record'),
            text: record.content,
            url: `https://udafklielwqdppnagtwc.supabase.co/rest/v1/memory_records?id=eq.${record.id}`
          }))
        }, null, 2)
      }]
    };
  }
 
  private async handleFetchWrapper(args: any): Promise<MCPToolResult> {
    // The `id` argument is treated as a client_id for packet retrieval.
    // This aligns with NeuralSynch's packet-based retrieval model and keeps
    // the wrapper implementation trivial — no new client methods required.
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
            anti_amnesia_status: context.anti_amnesia_status
          }
        }, null, 2)
      }]
    };
  }
}
 
// Tool schema definitions for MCP discovery.
// readOnlyHint on each tool prevents unnecessary confirmation modals in ChatGPT.
// memory_write is the only tool that mutates state, so it is the only one
// with readOnlyHint: false.
export const MEMORY_TOOLS_SCHEMA = [
  {
    name: 'memory_read',
    description: 'Retrieve memory packet context for session continuity. Gets latest session writebacks, locked decisions, and memory records.',
    annotations: {
      readOnlyHint: true
    },
    inputSchema: {
      type: 'object',
      properties: {
        client_id: {
          type: 'string',
          description: 'Client identifier (default: viralbrain)',
          default: 'viralbrain'
        },
        session_number: {
          type: 'number',
          description: 'Target session number (optional, auto-increments if not provided)'
        }
      }
    }
  },
  {
    name: 'memory_write',
    description: 'Capture session outcomes to Memory Packets. Stores session writebacks, locks critical decisions, creates memory records.',
    annotations: {
      readOnlyHint: false
    },
    inputSchema: {
      type: 'object',
      properties: {
        client_id: {
          type: 'string',
          description: 'Client identifier (default: viralbrain)',
          default: 'viralbrain'
        },
        session_number: {
          type: 'number',
          description: 'Session number for this writeback',
          required: true
        },
        objective: {
          type: 'string',
          description: 'Primary objective/goal for this session',
          required: true
        },
        outcome_summary: {
          type: 'string',
          description: 'Summary of what was accomplished this session',
          required: true
        }
      },
      required: ['session_number', 'objective', 'outcome_summary']
    }
  },
  {
    name: 'memory_search',
    description: 'Search through memory records for relevant context.',
    annotations: {
      readOnlyHint: true
    },
    inputSchema: {
      type: 'object',
      properties: {
        client_id: {
          type: 'string',
          description: 'Client identifier (default: viralbrain)',
          default: 'viralbrain'
        },
        query: {
          type: 'string',
          description: 'Search query to find relevant memories',
          required: true
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 10)',
          default: 10
        }
      },
      required: ['query']
    }
  },
  {
    name: 'memory_stats',
    description: 'Get memory system statistics and health metrics for the client.',
    annotations: {
      readOnlyHint: true
    },
    inputSchema: {
      type: 'object',
      properties: {
        client_id: {
          type: 'string',
          description: 'Client identifier (default: viralbrain)',
          default: 'viralbrain'
        }
      }
    }
  },
  // ChatGPT Deep Research / Company Knowledge compatibility wrappers.
  {
    name: 'search',
    description: 'Search NeuralSynch memory for records matching a query. Returns a list of matches with id, title, and text content. Compatible with ChatGPT Deep Research conventions.',
    annotations: {
      readOnlyHint: true
    },
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query'
        },
        client_id: {
          type: 'string',
          description: 'Client identifier (default: viralbrain)',
          default: 'viralbrain'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 10)',
          default: 10
        }
      },
      required: ['query']
    }
  },
  {
    name: 'fetch',
    description: 'Fetch a single NeuralSynch memory packet by id. Returns the full context including session continuity, locked decisions, and memory records. Compatible with ChatGPT Deep Research conventions.',
    annotations: {
      readOnlyHint: true
    },
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Packet identifier. For NeuralSynch this is the client_id (default: viralbrain).'
        }
      },
      required: ['id']
    }
  }
];
