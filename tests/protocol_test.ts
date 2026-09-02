// Protocol-level tests — what a client actually sees over JSON-RPC.
//
// The schema tests assert on the exported arrays. These assert on the wire:
// tools/list through MCPServer, and the GET / discovery document. If the two
// ever disagree, the wire is what matters.
//
// Run: deno test --allow-env tests/protocol_test.ts

import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { MCPServer } from "../mcp-protocol.ts";
import { MEMORY_TOOLS_SCHEMA } from "../memory-tools.ts";
import { CUSTODY_KEY_ENV } from "../custody-tools.ts";

Deno.test("tools/list advertises exactly 27 tools over JSON-RPC", async () => {
  const res: any = await new MCPServer().handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  });
  assertEquals(res.result.tools.length, 27);
});

Deno.test("tools/list still carries the original 12 first, unmodified", async () => {
  const res: any = await new MCPServer().handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
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

Deno.test("tools/list includes the S251 and S252 custody tool names", async () => {
  const res: any = await new MCPServer().handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  });
  const names = res.result.tools.map((t: any) => t.name);
  for (
    const n of [
      "get_record_by_id",
      // S251 read-only custody
      "custody_resolve_alias",
      "custody_get_metadata",
      "custody_retrieve",
      "custody_verify",
      // S252 governed custody
      "custody_store",
      "custody_begin_upload",
      "custody_finalize_upload",
      "custody_set_alias",
      "custody_list_versions",
      "custody_add_dependency",
      "custody_dependency_closure",
      "custody_export_session",
      "custody_scan_archive",
      "custody_report_missing",
    ]
  ) {
    assert(names.includes(n), `tools/list is missing ${n}`);
  }
});

Deno.test("initialize reports version 1.3.0", async () => {
  const res: any = await new MCPServer().handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
  });
  assertEquals(res.result.serverInfo.version, "1.3.0");
  assertEquals(res.result.serverInfo.name, "neuralsynch-memory");
});

Deno.test("GET / discovery document lists all 27 tools", async () => {
  const res = await new MCPServer().handleHTTP(
    new Request("https://example.test/", { method: "GET" }),
  );
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.tools.length, 27);
  assertEquals(body.server.version, "1.3.0");
});

Deno.test("POST /mcp without OAuth fails closed with resource metadata challenge", async () => {
  const res = await new MCPServer().handleHTTP(
    new Request("https://example.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    }),
  );
  assertEquals(res.status, 401);
  assert(
    res.headers.get("WWW-Authenticate")?.includes(
      "/.well-known/oauth-protected-resource",
    ),
  );
});

Deno.test("OAuth protected-resource metadata advertises the canonical /mcp resource URL", async () => {
  const res = await new MCPServer().handleHTTP(
    new Request("https://example.test/.well-known/oauth-protected-resource"),
  );
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.resource, "https://example.test/mcp");
  assertEquals(body.bearer_methods_supported, ["header"]);
  assertEquals(body.authorization_servers.length, 1);
});

Deno.test("OAuth consent route is additive and does not expose server credentials", async () => {
  const priorUrl = Deno.env.get("SUPABASE_URL");
  const priorAnon = Deno.env.get("SUPABASE_ANON_KEY");
  const priorService = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  Deno.env.set("SUPABASE_URL", "https://staging.example.test");
  Deno.env.set("SUPABASE_ANON_KEY", "public-test-key");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "must-not-escape");
  try {
    const res = await new MCPServer().handleHTTP(
      new Request("https://mcp.example.test/oauth/consent?authorization_id=a1"),
    );
    const html = await res.text();
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Cache-Control"), "no-store");
    assert(html.includes("Authorize NeuralSynch"));
    assert(html.includes("https://staging.example.test"));
    assert(!html.includes("must-not-escape"));
  } finally {
    priorUrl === undefined
      ? Deno.env.delete("SUPABASE_URL")
      : Deno.env.set("SUPABASE_URL", priorUrl);
    priorAnon === undefined
      ? Deno.env.delete("SUPABASE_ANON_KEY")
      : Deno.env.set("SUPABASE_ANON_KEY", priorAnon);
    priorService === undefined
      ? Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY")
      : Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", priorService);
  }
});

Deno.test("unchanged transport behaviour: OPTIONS preflight and unknown method", async () => {
  const server = new MCPServer();

  const preflight = await server.handleHTTP(
    new Request("https://example.test/", { method: "OPTIONS" }),
  );
  assertEquals(preflight.status, 204);
  assertEquals(preflight.headers.get("Access-Control-Allow-Origin"), "*");

  const unknown: any = await server.handleRequest({
    jsonrpc: "2.0",
    id: 9,
    method: "no/such/method",
  });
  assertEquals(unknown.error.code, -32601);
});

Deno.test("no custody key is required to LIST tools — only to call them", async () => {
  Deno.env.delete(CUSTODY_KEY_ENV);
  const res: any = await new MCPServer().handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  });
  assertEquals(res.result.tools.length, 27);
});
