// NeuralSynch MCP Server - Memory Packet System
// Production-ready MCP server for Claude anti-amnesia architecture

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { MCPProtocol } from "./mcp-protocol.ts";
import { MemoryTools } from "./memory-tools.ts";

const PORT = parseInt(Deno.env.get("PORT") || "8000");

console.log("🧠 NeuralSynch MCP Server starting...");
console.log(`📡 Server will run on port ${PORT}`);
console.log("🔗 MCP Protocol: 2024-11-05");
console.log("🗄️ Memory Backend: NeuralSynch Supabase");

// Initialize memory tools
const memoryTools = new MemoryTools();

// Initialize MCP protocol handler
const mcpProtocol = new MCPProtocol();

// Add all memory tools to MCP
mcpProtocol.addTool({
  name: "memory_read",
  description: "Retrieve Memory Packet context for client session",
  inputSchema: {
    type: "object",
    properties: {
      client_id: { 
        type: "string", 
        description: "Client identifier for context retrieval" 
      }
    },
    required: ["client_id"]
  }
}, memoryTools.readMemory.bind(memoryTools));

mcpProtocol.addTool({
  name: "memory_write", 
  description: "Write session outcomes to Memory Packets",
  inputSchema: {
    type: "object",
    properties: {
      client_id: { type: "string" },
      session_outcome: { type: "string" },
      decisions_captured: { type: "array", items: { type: "string" } },
      next_session_context: { type: "string" }
    },
    required: ["client_id", "session_outcome"]
  }
}, memoryTools.writeMemory.bind(memoryTools));

mcpProtocol.addTool({
  name: "memory_search",
  description: "Semantic search through memory records", 
  inputSchema: {
    type: "object",
    properties: {
      client_id: { type: "string" },
      query: { type: "string" },
      limit: { type: "number", default: 10 }
    },
    required: ["client_id", "query"]
  }
}, memoryTools.searchMemory.bind(memoryTools));

mcpProtocol.addTool({
  name: "memory_stats",
  description: "Get Memory Packet system statistics",
  inputSchema: {
    type: "object", 
    properties: {
      client_id: { type: "string" }
    },
    required: ["client_id"]
  }
}, memoryTools.getStats.bind(memoryTools));

console.log("🛠️ Available tools: memory_read, memory_write, memory_search, memory_stats");

// HTTP request handler
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // Health check endpoint
  if (url.pathname === "/health") {
    return new Response(JSON.stringify({
      status: "healthy",
      service: "NeuralSynch MCP Server",
      version: "1.0.0",
      protocol: "MCP 2024-11-05",
      tools: ["memory_read", "memory_write", "memory_search", "memory_stats"],
      timestamp: new Date().toISOString()
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  // MCP protocol endpoint
  if (url.pathname === "/" && req.method === "POST") {
    try {
      const body = await req.json();
      const response = await mcpProtocol.handleRequest(body);
      
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    } catch (error) {
      return new Response(JSON.stringify({
        error: "Invalid JSON request",
        details: error.message
      }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS", 
        "Access-Control-Allow-Headers": "Content-Type"
      }
    });
  }

  // 404 for other paths
  return new Response("Not Found", { status: 404 });
}

// Start server
console.log(`✅ NeuralSynch MCP Server ready on http://0.0.0.0:${PORT}`);
console.log("🎯 Ready for Claude API integration via MCP connector");
console.log(`🔍 Test with: curl http://localhost:${PORT}/health`);

await serve(handler, { port: PORT });
