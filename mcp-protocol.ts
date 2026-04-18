===== START =====
// MCP (Model Context Protocol) implementation for NeuralSynch
// Handles JSON-RPC 2.0 protocol for tool discovery and execution
// Supports Streamable HTTP transport for Claude Desktop/Web/ChatGPT connectors

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
  private sessionId: string;
  private serverInfo = {
    name: 'neuralsynch-memory',
    version: '1.2.0',
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
    this.sessionId = crypto.randomUUID();
  }

  async handleRequest(request: MCPRequest): Promise<MCPResponse | null> {
    try {
      switch (request.method) {
        case 'initialize':
          return this.handleInitialize(request);

        case 'notifications/initialized':
          // Notification — no response required
          return null;

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
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: {
          name: this.serverInfo.name,
          version: this.serverInfo.version,
        }
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

  // HTTP handler for web requests — supports both plain JSON and Streamable HTTP (SSE)
  // Routes: POST /  and  POST /mcp  both dispatch to MCP JSON-RPC.
  // The /mcp alias exists for OpenAI ChatGPT connector conventions.
  async handleHTTP(request: Request): Promise<Response> {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, Mcp-Session-Id',
      'Access-Control-Expose-Headers': 'Mcp-Session-Id',
    };

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    const url = new URL(request.url);
    const isMcpPath = url.pathname === '/' || url.pathname === '/mcp';

    // Handle GET /health BEFORE generic GET
    if (request.method === 'GET' && url.pathname === '/health') {
      try {
        const stats = await this.toolHandler.handleToolCall({
          name: 'memory_stats',
          arguments: { client_id: 'viralbrain' }
        });
        return new Response(
          JSON.stringify({
            status: 'healthy',
            server: this.serverInfo.name,
            timestamp: new Date().toISOString(),
            vault: JSON.parse(stats.content[0].text)
          }, null, 2),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      } catch (error) {
        return new Response(
          JSON.stringify({ status: 'degraded', error: error.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // Handle GET /.well-known/oauth-protected-resource (RFC 9728)
    // Signals that this resource has no authentication requirement.
    // ChatGPT's Create app form probes this during OAuth discovery.
    if (request.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource') {
      return new Response(
        JSON.stringify({
          resource: `${url.origin}/`,
          authorization_servers: [],
          scopes_supported: [],
          bearer_methods_supported: []
        }, null, 2),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Handle GET /.well-known/oauth-authorization-server (RFC 8414)
    // ChatGPT probes this endpoint during OAuth discovery.
    // Minimal stub declares no auth endpoints — signals no OAuth required.
    if (request.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      return new Response(
        JSON.stringify({
          issuer: url.origin,
          response_types_supported: [],
          grant_types_supported: [],
          token_endpoint_auth_methods_supported: ['none']
        }, null, 2),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Handle GET /.well-known/openid-configuration
    // ChatGPT may probe this as part of OIDC discovery. Same no-auth signal.
    if (request.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      return new Response(
        JSON.stringify({
          issuer: url.origin,
          response_types_supported: [],
          grant_types_supported: [],
          token_endpoint_auth_methods_supported: ['none']
        }, null, 2),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Handle GET / and GET /mcp — server info
    if (request.method === 'GET' && isMcpPath) {
      return new Response(
        JSON.stringify({
          server: this.serverInfo,
          tools: MEMORY_TOOLS_SCHEMA,
          status: 'ready',
          protocol: 'MCP 2024-11-05',
          transport: 'streamable-http',
          endpoints: {
            'GET /': 'Server information',
            'GET /mcp': 'Server information (alias)',
            'POST /': 'MCP JSON-RPC requests (JSON or SSE)',
            'POST /mcp': 'MCP JSON-RPC requests (alias for OpenAI connector convention)',
            'GET /health': 'Health check with vault stats',
            'GET /.well-known/oauth-protected-resource': 'RFC 9728 — declares no-auth resource',
            'GET /.well-known/oauth-authorization-server': 'RFC 8414 — declares no auth server',
            'GET /.well-known/openid-configuration': 'OIDC discovery — declares no auth server'
          }
        }, null, 2),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Handle DELETE — session termination
    if (request.method === 'DELETE' && isMcpPath) {
      return new Response(null, {
        status: 200,
        headers: { ...corsHeaders, 'Mcp-Session-Id': this.sessionId }
      });
    }

    // Handle POST / and POST /mcp — MCP JSON-RPC requests
    if (request.method === 'POST' && isMcpPath) {
      try {
        const body = await request.json();
        const acceptHeader = request.headers.get('Accept') || '';
        const wantsSSE = acceptHeader.includes('text/event-stream');

        // Handle batch requests (array of JSON-RPC messages)
        const requests: MCPRequest[] = Array.isArray(body) ? body : [body];
        const responses: MCPResponse[] = [];

        for (const req of requests) {
          const response = await this.handleRequest(req);
          if (response !== null) {
            responses.push(response);
          }
        }

        // If client wants SSE (Streamable HTTP transport)
        if (wantsSSE) {
          const sseBody = responses
            .map(r => `event: message\ndata: ${JSON.stringify(r)}\n\n`)
            .join('');

          return new Response(sseBody, {
            status: 200,
            headers: {
              ...corsHeaders,
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache, no-transform',
              'Connection': 'keep-alive',
              'Mcp-Session-Id': this.sessionId,
            }
          });
        }

        // Plain JSON response (backward compatible with curl testing)
        const result = responses.length === 1 ? responses[0] : responses;
        return new Response(
          JSON.stringify(result),
          {
            status: 200,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json',
              'Mcp-Session-Id': this.sessionId,
            }
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
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}
===== END =====
