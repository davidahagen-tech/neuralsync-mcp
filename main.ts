// NeuralSynch Standalone MCP Server
// Production-ready MCP server for Memory Packet anti-amnesia system

import { serve } from "@std/http/server.ts";
import { MCPServer } from './mcp-protocol.ts';

const mcpServer = new MCPServer();
// Debug PORT environment variable
const PORT_ENV = Deno.env.get('PORT');
const port = PORT_ENV ? parseInt(PORT_ENV) : 8000;

console.log('🧠 NeuralSynch MCP Server starting...');
console.log(`🔍 PORT environment variable: "${PORT_ENV}"`);
console.log(`🔍 Parsed port value: ${port}`);
console.log(`📍 Server will run on port ${port}`);
console.log('🔗 MCP Protocol: 2024-11-05');
console.log('💾 Memory Backend: NeuralSynch Supabase');
console.log('🛠️  Available tools: memory_read, memory_write, memory_search, memory_stats');

async function handler(request: Request): Promise<Response> {
  const startTime = Date.now();
  
  try {
    const response = await mcpServer.handleHTTP(request);
    const duration = Date.now() - startTime;
    console.log(`${request.method} ${new URL(request.url).pathname} - ${response.status} (${duration}ms)`);
    return response;
  } catch (error) {
    console.error('Server error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

serve(handler, {
  port,
  onListen: ({ hostname, port }) => {
    console.log(`✅ NeuralSynch MCP Server ready on http://${hostname}:${port}`);
    console.log('🎯 Ready for Claude API integration via MCP connector');
  }
});
