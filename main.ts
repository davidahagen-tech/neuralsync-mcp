// NeuralSynch Standalone MCP Server - Modern Deno Deploy Pattern
// Production-ready MCP server for Memory Packet anti-amnesia system

import { MCPServer } from './mcp-protocol.ts';

const mcpServer = new MCPServer();

// Modern Deno Deploy port pattern (research-backed)
const port = parseInt(Deno.env.get('PORT') ?? '8000');

console.log('🧠 NeuralSynch MCP Server starting...');
console.log(`🔍 PORT environment variable: "${Deno.env.get('PORT')}"`);
console.log(`🔍 Parsed port value: ${port}`);
console.log(`📍 Server will run on port ${port}`);
console.log('🔗 MCP Protocol: 2024-11-05');
console.log('💾 Memory Backend: NeuralSynch Supabase');
console.log('🛠️ Available tools: memory_read, memory_write, memory_search, memory_stats');

// Modern Deno.serve() pattern - preferred by Deno Deploy
export default {
  async fetch(request: Request): Promise<Response> {
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
  },

  port: port
} satisfies Deno.ServeDefaultExport;
