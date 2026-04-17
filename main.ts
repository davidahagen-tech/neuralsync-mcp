// NeuralSynch Standalone MCP Server
// Production-ready MCP server for Memory Packet anti-amnesia system
// Deploy to Deno Deploy for global edge distribution

import { serve } from "@std/http/server.ts";
import { MCPServer } from './mcp-protocol.ts';

// Initialize the MCP server
const mcpServer = new MCPServer();

// Main request handler
async function handler(request: Request): Promise<Response> {
  const startTime = Date.now();
  const url = new URL(request.url);
  
  // Log incoming requests
  console.log(`${new Date().toISOString()} ${request.method} ${url.pathname} from ${request.headers.get('user-agent') || 'unknown'}`);
  
  try {
    // Route all requests to MCP server
    const response = await mcpServer.handleHTTP(request);
    
    // Log response time
    const duration = Date.now() - startTime;
    console.log(`Request completed in ${duration}ms with status ${response.status}`);
    
    return response;
  } catch (error) {
    console.error('Server error:', error);
    
    return new Response(
      JSON.stringify({
        error: 'Internal server error',
        message: error.message,
        timestamp: new Date().toISOString()
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      }
    );
  }
}

// Server configuration
const port = parseInt(Deno.env.get('PORT') || '8000');

// Start the server
console.log('🧠 NeuralSynch MCP Server starting...');
console.log(`📍 Server will run on port ${port}`);
console.log('🔗 MCP Protocol: 2024-11-05');
console.log('💾 Memory Backend: NeuralSynch Supabase');
console.log('🛠️  Available tools: memory_read, memory_write, memory_search, memory_stats');

serve(handler, { 
  port,
  onListen: ({ hostname, port }) => {
    console.log(`✅ NeuralSynch MCP Server ready on http://${hostname}:${port}`);
    console.log('🎯 Ready for Claude API integration via MCP connector');
    console.log('📋 Test with: curl http://localhost:' + port + '/health');
  }
});
