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
}

// Tool schema definitions for MCP discovery
export const MEMORY_TOOLS_SCHEMA = [
  {
    name: 'memory_read',
    description: 'Retrieve memory packet context for session continuity. Gets latest session writebacks, locked decisions, and memory records.',
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
  }
];
