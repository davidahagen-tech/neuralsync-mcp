// Protocol-level tests — what a client actually sees over JSON-RPC.
//
// The schema tests assert on the exported arrays. These assert on the wire:
// tools/list through MCPServer, and the GET / discovery document. If the two
// ever disagree, the wire is what matters.
//
// Run: deno test --allow-env tests/protocol_test.ts

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import { MCPServer } from '../mcp-protocol.ts';
import { MEMORY_TOOLS_SCHEMA } from '../memory-tools.ts';
import { CUSTODY_KEY_ENV } from '../custody-tools.ts';

Deno.test('tools/list advertises exactly 17 tools over JSON-RPC', async () => {
  const res: any = await new MCPServer().handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
  });
  assertEquals(res.result.tools.length, 17);
});

Deno.test('tools/list still carries the original 12 first, unmodified', async () => {
  const res: any = await new MCPServer().handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
  });
  const wire = res.result.tools;
  for (let i = 0; i < 12; i++) {
    assertEquals(
      JSON.stringify(wire[i]),
      JSON.stringify(MEMORY_TOOLS_SCHEMA[i]),
      `wire tool ${i} differs from the original schema`,
    );
  }
});

Deno.test('tools/list includes the 5 new tool names', async () => {
  const res: any = await new MCPServer().handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
  });
  const names = res.result.tools.map((t: any) => t.name);
  for (
    const n of [
      'get_record_by_id',
      'custody_resolve_alias',
      'custody_get_metadata',
      'custody_retrieve',
      'custody_verify',
    ]
  ) {
    assert(names.includes(n), `tools/list is missing ${n}`);
  }
});

Deno.test('initialize reports version 1.3.0', async () => {
  const res: any = await new MCPServer().handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
  });
  assertEquals(res.result.serverInfo.version, '1.3.0');
  assertEquals(res.result.serverInfo.name, 'neuralsynch-memory');
});

Deno.test('GET / discovery document lists all 17 tools', async () => {
  const res = await new MCPServer().handleHTTP(
    new Request('https://example.test/', { method: 'GET' }),
  );
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.tools.length, 17);
  assertEquals(body.server.version, '1.3.0');
});

Deno.test('unchanged transport behaviour: OPTIONS preflight and unknown method', async () => {
  const server = new MCPServer();

  const preflight = await server.handleHTTP(
    new Request('https://example.test/', { method: 'OPTIONS' }),
  );
  assertEquals(preflight.status, 204);
  assertEquals(preflight.headers.get('Access-Control-Allow-Origin'), '*');

  const unknown: any = await server.handleRequest({
    jsonrpc: '2.0',
    id: 9,
    method: 'no/such/method',
  });
  assertEquals(unknown.error.code, -32601);
});

Deno.test('no custody key is required to LIST tools — only to call them', async () => {
  Deno.env.delete(CUSTODY_KEY_ENV);
  const res: any = await new MCPServer().handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
  });
  assertEquals(res.result.tools.length, 17);
});
