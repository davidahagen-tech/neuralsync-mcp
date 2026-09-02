// MCP (Model Context Protocol) implementation for NeuralSynch — v1.0.1 (S187 close)
// Handles JSON-RPC 2.0 protocol for tool discovery and execution
// Supports Streamable HTTP transport for Claude Desktop/Web/ChatGPT connectors
//
// CHANGES FROM v1.1-diag (S187 close, 2026-05-03):
//   1. handleHTTP — removed the CP0 diagnostic console.log block at the
//      JSON-RPC body arrival point (immediately after `await request.json()`).
//      The block logged raw inbound body shape for tools/call memory_write
//      requests. Cause of the silent-drop was diagnosed as v2.1
//      MEMORY_TOOLS_SCHEMA bare items: { type: object } treated
//      inconsistently by strict MCP validators (claude.ai web framework
//      specifically) — fixed in memory-tools.ts v2.2 by adding explicit
//      properties + required + additionalProperties: true to all five
//      array-of-object item schemas. CP0 served its diagnostic purpose
//      (confirmed args_keys missing decisions_made entirely from
//      claude.ai web inbound bodies) and is no longer needed.
//
//   2. No functional changes from the v1 baseline. Only the diagnostic
//      log block and its surrounding try/catch were removed.
//
//   Note: v1.0.1 numbering signals "v1 with diagnostic explicitly
//   removed" rather than reverting to v1 directly, so the deploy log
//   carries an explicit cleanup version separate from the original v1.

// CHANGES IN v1.3.0 (S251 bounded custody exposure):
//   1. Advertises ALL_TOOLS_SCHEMA (17 tools) instead of MEMORY_TOOLS_SCHEMA
//      (12 tools). The original 12 entries are unchanged and still come from
//      MEMORY_TOOLS_SCHEMA; ALL_TOOLS_SCHEMA appends get_record_by_id and the
//      four read-only custody tools.
//   2. serverInfo.version 1.2.0 -> 1.3.0.
//   No transport, CORS, SSE, session or well-known behaviour was touched.

import { ALL_TOOLS_SCHEMA, MemoryToolHandler } from "./memory-tools.ts";
import {
  authenticateMCPRequest,
  bindToolArguments,
  DEFAULT_SUPABASE_URL,
  MCPAuthError,
  type MCPPrincipal,
} from "./auth.ts";
import { oauthConsentResponse } from "./oauth-consent.ts";

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
    name: "neuralsynch-memory",
    version: "1.3.0",
    description: "NeuralSynch Memory Packet system for Claude anti-amnesia",
    author: "Ascension 1 Capital LLC",
    capabilities: {
      tools: true,
      resources: false,
      prompts: false,
      logging: true,
    },
  };

  constructor() {
    this.toolHandler = new MemoryToolHandler();
    this.sessionId = crypto.randomUUID();
  }

  async handleRequest(
    request: MCPRequest,
    principal?: MCPPrincipal,
  ): Promise<MCPResponse | null> {
    try {
      switch (request.method) {
        case "initialize":
          return this.handleInitialize(request);
        case "notifications/initialized":
          return null;
        case "tools/list":
          return this.handleToolsList(request);
        case "tools/call":
          return this.handleToolCall(request, principal);
        case "ping":
          return this.handlePing(request);
        default:
          return this.createErrorResponse(
            request.id,
            -32601,
            `Method not found: ${request.method}`,
          );
      }
    } catch (error) {
      console.error("MCP request handling error:", error);
      return this.createErrorResponse(
        request.id,
        -32603,
        `Internal error: ${(error as Error).message}`,
      );
    }
  }

  private handleInitialize(request: MCPRequest): MCPResponse {
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: {
          name: this.serverInfo.name,
          version: this.serverInfo.version,
        },
      },
    };
  }

  private handleToolsList(request: MCPRequest): MCPResponse {
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        tools: ALL_TOOLS_SCHEMA,
      },
    };
  }

  private async handleToolCall(
    request: MCPRequest,
    principal?: MCPPrincipal,
  ): Promise<MCPResponse> {
    const { name, arguments: args } = request.params || {};
    if (!name) {
      return this.createErrorResponse(
        request.id,
        -32602,
        "Tool name is required",
      );
    }
    try {
      const boundArgs = principal
        ? bindToolArguments(name, args || {}, principal)
        : (args || {});
      const result = await this.toolHandler.handleToolCall({
        name,
        arguments: boundArgs,
      });
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: result.content,
          isError: result.isError || false,
        },
      };
    } catch (error) {
      return this.createErrorResponse(
        request.id,
        -32603,
        `Tool execution failed: ${(error as Error).message}`,
      );
    }
  }

  private handlePing(request: MCPRequest): MCPResponse {
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        status: "healthy",
        timestamp: new Date().toISOString(),
        server: this.serverInfo.name,
        uptime: Date.now(),
      },
    };
  }

  private createErrorResponse(
    id: any,
    code: number,
    message: string,
  ): MCPResponse {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code,
        message,
      },
    };
  }

  // HTTP handler for web requests — supports both plain JSON and Streamable HTTP (SSE)
  async handleHTTP(request: Request): Promise<Response> {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, Accept, Mcp-Session-Id",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    const url = new URL(request.url);
    const isMcpPath = url.pathname === "/" || url.pathname === "/mcp";
    const resourceUrl = Deno.env.get("MCP_RESOURCE_URL") ?? `${url.origin}/mcp`;
    const resourceMetadataUrl =
      `${url.origin}/.well-known/oauth-protected-resource`;
    const authorizationServer = `${
      Deno.env.get("SUPABASE_URL") ?? DEFAULT_SUPABASE_URL
    }/auth/v1`;

    if (request.method === "GET" && url.pathname === "/oauth/consent") {
      return oauthConsentResponse();
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response(
        JSON.stringify(
          {
            status: "healthy",
            server: this.serverInfo.name,
            timestamp: new Date().toISOString(),
          },
          null,
          2,
        ),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    if (
      request.method === "GET" &&
      url.pathname === "/.well-known/oauth-protected-resource"
    ) {
      return new Response(
        JSON.stringify(
          {
            resource: resourceUrl,
            authorization_servers: [authorizationServer],
            scopes_supported: ["openid", "email"],
            bearer_methods_supported: ["header"],
          },
          null,
          2,
        ),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    if (request.method === "GET" && isMcpPath) {
      return new Response(
        JSON.stringify(
          {
            server: this.serverInfo,
            tools: ALL_TOOLS_SCHEMA,
            status: "ready",
            protocol: "MCP 2024-11-05",
            transport: "streamable-http",
            endpoints: {
              "GET /": "Server information",
              "GET /mcp": "Server information (alias)",
              "POST /": "MCP JSON-RPC requests (JSON or SSE)",
              "POST /mcp":
                "MCP JSON-RPC requests (alias for OpenAI connector convention)",
              "GET /health": "Non-sensitive health check",
              "GET /.well-known/oauth-protected-resource":
                "RFC 9728 OAuth resource metadata",
            },
          },
          null,
          2,
        ),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    if (request.method === "DELETE" && isMcpPath) {
      return new Response(null, {
        status: 200,
        headers: { ...corsHeaders, "Mcp-Session-Id": this.sessionId },
      });
    }

    if (request.method === "POST" && isMcpPath) {
      try {
        const principal = await authenticateMCPRequest(request);
        const body = await request.json();

        const acceptHeader = request.headers.get("Accept") || "";
        const wantsSSE = acceptHeader.includes("text/event-stream");

        const requests: MCPRequest[] = Array.isArray(body) ? body : [body];
        const responses: MCPResponse[] = [];
        for (const req of requests) {
          const response = await this.handleRequest(req, principal);
          if (response !== null) {
            responses.push(response);
          }
        }

        if (wantsSSE) {
          const sseBody = responses
            .map((r) => `event: message\ndata: ${JSON.stringify(r)}\n\n`)
            .join("");
          return new Response(sseBody, {
            status: 200,
            headers: {
              ...corsHeaders,
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache, no-transform",
              "Connection": "keep-alive",
              "Mcp-Session-Id": this.sessionId,
            },
          });
        }

        const result = responses.length === 1 ? responses[0] : responses;
        return new Response(
          JSON.stringify(result),
          {
            status: 200,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json",
              "Mcp-Session-Id": this.sessionId,
            },
          },
        );
      } catch (error) {
        if (error instanceof MCPAuthError) {
          return new Response(
            JSON.stringify({
              error: "unauthorized",
              error_description: error.message,
            }),
            {
              status: error.status,
              headers: {
                ...corsHeaders,
                "Content-Type": "application/json",
                "WWW-Authenticate":
                  `Bearer resource_metadata="${resourceMetadataUrl}"`,
              },
            },
          );
        }
        const errorResponse = this.createErrorResponse(
          null,
          -32700,
          `Parse error: ${(error as Error).message}`,
        );
        return new Response(
          JSON.stringify(errorResponse),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
    }

    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      {
        status: 405,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
}
