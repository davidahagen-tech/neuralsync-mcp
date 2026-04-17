// MCP (Model Context Protocol) implementation for NeuralSynch
// Handles JSON-RPC 2.0 protocol for tool discovery and execution

import { MemoryToolHandler, MEMORY_TOOLS_SCHEMA } from './memory-tools.ts';

export interface MCPRequest {
  jsonrpc: string;
  id?: string | number;
  method: string;
  params?: any;
}

export interface MCPResponse {
  jsonrpc: string;
  id?: string | number;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export class MCPServer {
  private toolHandler: MemoryToolHandler;
  private serverInfo = {
    name: 'neuralsync-memory',
    version: '1.0.0',
    description: 'NeuralSynch Memory Packet system for Claude anti-amnesia',
    author: 'Ascension 1 Capital LLC',
    capabilities: {
      tools: true,
      resources: false,
      prompts: false,
      logging: true
    }
  };

  constructor() {
    this.toolHandler = new MemoryToolHandler();
  }

  async handleRequest(request: MCPRequest): Promise<MCPResponse> {
    try {
      switch (request.method) {
        case 'initialize':
          return this.handleInitialize(request);
        
        case 'tools/list':
          return this.handleToolsList(request);
        
        case 'tools/call':
          return this.handleToolCall(request);
        
        case 'ping':
          return this.handlePing(request);
        
        default:
          return this.createErrorResponse(
            request.id,
            -32601,
            `Method not found: ${request.method}`
          );
      }
    } catch (error) {
      console.error('MCP request handling error:', error);
      return this.createErrorResponse(
        request.id,
        -32603,
        `Internal error: ${error.message}`
      );
    }
  }

  private handleInitialize(request: MCPRequest): MCPResponse {
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: this.serverInfo.capabilities,
        serverInfo: this.serverInfo
      }
    };
  }

  private handleToolsList(request: MCPRequest): MCPResponse {
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        tools: MEMORY_TOOLS_SCHEMA
      }
    };
  }

  private async handleToolCall(request: MCPRequest): Promise<MCPResponse> {
    const { name, arguments: args } = request.params || {};
    
    if (!name) {
      return this.createErrorResponse(
        request.id,
        -32602,
        'Tool name is required'
      );
    }

    try {
      const result = await this.toolHandler.handleToolCall({
        name,
        arguments: args || {}
      });

      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          content: result.content,
          isError: result.isError || false
        }
      };
    } catch (error) {
      return this.createErrorResponse(
        request.id,
        -32603,
        `Tool execution failed: ${error.message}`
      );
    }
  }

  private handlePing(request: MCPRequest): MCPResponse {
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        server: this.serverInfo.name,
        uptime: Date.now()
      }
    };
  }

  private createErrorResponse(id: any, code: number, message: string): MCPResponse {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message
      }
    };
  }

  // HTTP handler for web requests
  async handleHTTP(request: Request): Promise<Response> {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Content-Type': 'application/json'
    };

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { 
        status: 200, 
        headers: corsHeaders 
      });
    }

    // Handle GET requests - return server info
    if (request.method === 'GET') {
      return new Response(
        JSON.stringify({
          server: this.serverInfo,
          tools: MEMORY_TOOLS_SCHEMA,
          status: 'ready',
          protocol: 'MCP 2024-11-05',
          endpoints: {
            'GET /': 'Server information',
            'POST /': 'MCP JSON-RPC requests',
            'GET /health': 'Health check'
          }
        }, null, 2),
        {
          status: 200,
          headers: corsHeaders
        }
      );
    }

    // Handle health checks
    if (request.method === 'GET' && new URL(request.url).pathname === '/health') {
      return new Response(
        JSON.stringify({
          status: 'healthy',
          server: this.serverInfo.name,
          timestamp: new Date().toISOString()
        }),
        {
          status: 200,
          headers: corsHeaders
        }
      );
    }

    // Handle MCP JSON-RPC requests
    if (request.method === 'POST') {
      try {
        const mcpRequest: MCPRequest = await request.json();
        const mcpResponse = await this.handleRequest(mcpRequest);
        
        return new Response(
          JSON.stringify(mcpResponse),
          {
            status: 200,
            headers: corsHeaders
          }
        );
      } catch (error) {
        const errorResponse = this.createErrorResponse(
          null,
          -32700,
          `Parse error: ${error.message}`
        );
        
        return new Response(
          JSON.stringify(errorResponse),
          {
            status: 400,
            headers: corsHeaders
          }
        );
      }
    }

    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      {
        status: 405,
        headers: corsHeaders
      }
    );
  }
}
