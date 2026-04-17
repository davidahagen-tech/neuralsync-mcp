// NeuralSynch Standalone MCP Server - Deno Deploy Pattern
// Production-ready MCP server for Memory Packet anti-amnesia system

import { MCPServer } from './mcp-protocol.ts';

const mcpServer = new MCPServer();

console.log('🧠 NeuralSynch MCP Server starting...');
console.log('🔗 MCP Protocol: 2024-11-05');
console.log('💾 Memory Backend: NeuralSynch Supabase');
console.log('🛠️ Available tools: memory_read, memory_write, memory_search, memory_stats');
console.log('🎯 Deno Deploy will handle port assignment automatically');

// Deno Deploy pattern - NO port specification needed
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
  }
} satisfies Deno.ServeDefaultExport;
