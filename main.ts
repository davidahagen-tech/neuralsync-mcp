import { MCPServer } from './mcp-protocol.ts';

const server = new MCPServer();

export default {
  async fetch(request: Request): Promise<Response> {
    return await server.handleHTTP(request);
  }
};
