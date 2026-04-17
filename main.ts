// NeuralSynch Standalone MCP Server - Direct Protocol Pattern
// Production-ready MCP server for Memory Packet anti-amnesia system

import { MCPServer } from './mcp-protocol.ts';

const mcpServer = new MCPServer();

console.log('🧠 NeuralSynch MCP Server starting...');
console.log('🔗 MCP Protocol: 2024-11-05');
console.log('💾 Memory Backend: NeuralSynch Supabase');
console.log('🛠️ Available tools: memory_read, memory_write, memory_search, memory_stats');
console.log('🎯 Using direct protocol handler (no internal server)');

// Deno Deploy pattern - direct protocol handling
export default {
  async fetch(request: Request): Promise<Response> {
    const startTime = Date.now();
    
    try {
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
        const url = new URL(request.url);
        
        if (url.pathname === '/health') {
          return new Response(
            JSON.stringify({
              status: 'healthy',
              server: 'NeuralSynch MCP Server',
              timestamp: new Date().toISOString(),
              tools: ['memory_read', 'memory_write', 'memory_search', 'memory_stats']
            }),
            { status: 200, headers: corsHeaders }
          );
        }

        return new Response(
          JSON.stringify({
            server: 'NeuralSynch MCP Server',
            version: '1.0.0',
            protocol: 'MCP 2024-11-05',
            tools: ['memory_read', 'memory_write', 'memory_search', 'memory_stats'],
            endpoints: {
              'GET /': 'Server information',
              'POST /': 'MCP JSON-RPC requests',
              'GET /health': 'Health check'
            }
          }, null, 2),
          { status: 200, headers: corsHeaders }
        );
      }

      // Handle MCP JSON-RPC requests
      if (request.method === 'POST') {
        const mcpRequest = await request.json();
        const mcpResponse = await mcpServer.handleRequest(mcpRequest);
        
        const duration = Date.now() - startTime;
        console.log(`POST ${new URL(request.url).pathname} - 200 (${duration}ms)`);
        
        return new Response(
          JSON.stringify(mcpResponse),
          { status: 200, headers: corsHeaders }
        );
      }

      return new Response(
        JSON.stringify({ error: 'Method not allowed' }),
        { status: 405, headers: corsHeaders }
      );

    } catch (error) {
      console.error('Server error:', error);
      const duration = Date.now() - startTime;
      console.log(`${request.method} ${new URL(request.url).pathname} - 500 (${duration}ms)`);
      
      return new Response(JSON.stringify({ 
        error: 'Internal server error',
        message: error.message 
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
} satisfies Deno.ServeDefaultExport;
