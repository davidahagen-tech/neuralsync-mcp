import { assertEquals, assertThrows } from "jsr:@std/assert@^1.0.0";
import { bindToolArguments } from "../auth.ts";
import { callPersonalCapability, PERSONAL_TOOLS_SCHEMA } from "../personal-tools.ts";
const principal = {
  userId: "u",
  accessToken: "opaque-oauth",
  tenantRoles: new Map<string, string>(),
};
Deno.test("Concept Lab is discoverable and transports the unchanged native request", async () => {
  assertEquals(PERSONAL_TOOLS_SCHEMA[0].inputSchema.properties.operation.enum.includes("concept"),true);
  const payload = {action:"step",id:"project",version:1,step:"blueprint",request_id:"stable",expectedVersion:4};
  const args=bindToolArguments("personal_capability",{operation:"concept",conversation_key:"origin-conversation",payload},principal);
  const result=await callPersonalCapability(args,async(_url,init)=>{
    assertEquals(JSON.parse(String(init?.body)),{operation:"concept",conversation_key:"origin-conversation",payload});
    return Response.json({workspace:{version:1},delivery:{complete:true}});
  });
  assertEquals(result.isError,false);
});
Deno.test("Personal principal gains no organizational memory/custody permission", () => {
  assertThrows(() => bindToolArguments("memory_read", {}, principal));
  assertThrows(() => bindToolArguments("custody_store", {}, principal));
  const args = bindToolArguments("personal_capability", {
    operation: "session",
    conversation_key: "key",
    payload: {},
  }, principal);
  assertEquals(args.client_id, undefined);
  assertEquals(JSON.stringify(args).includes("opaque-oauth"), false);
});
Deno.test("MCP Personal transport preserves full output and evidence without retries", async () => {
  const full = JSON.stringify({
    summary: "Full output αβγ ".repeat(800),
    citations: [{ url: "https://example.invalid/cite" }],
  });
  let calls = 0;
  const args = bindToolArguments("personal_capability", {
    operation: "invoke",
    conversation_key: "key",
    payload: { prompt: "Humanizer: draft", expectedVersion: 1 },
  }, principal);
  const result = await callPersonalCapability(args, async (input, init) => {
    calls++;
    assertEquals(String(input).endsWith("/personal-capabilities"), true);
    assertEquals(
      new Headers(init?.headers).get("Authorization"),
      "Bearer opaque-oauth",
    );
    assertEquals(String(init?.body).includes("opaque-oauth"), false);
    return new Response(full, {
      headers: { "Content-Type": "application/json" },
    });
  });
  assertEquals(result.content[0].text, full);
  assertEquals(calls, 1);
});
Deno.test("MCP artifact transport returns actual byte-identical report, not a preview", async () => {
  const bytes = new Uint8Array([0, 255, 128, 64, 32]);
  const args = bindToolArguments("personal_capability", {
    operation: "report",
    conversation_key: "key",
    payload: { action: "retrieve" },
  }, principal);
  const result = await callPersonalCapability(
    args,
    async () =>
      new Response(bytes, { headers: { "Content-Type": "application/pdf" } }),
  );
  const artifact = JSON.parse(result.content[0].text);
  assertEquals(
    Array.from(atob(artifact.data), (c) => c.charCodeAt(0)),
    Array.from(bytes),
  );
  assertEquals(artifact.complete, true);
  assertEquals(artifact.byte_length, bytes.length);
  assertEquals(artifact.sha256.length, 64);
});

Deno.test("authenticated MCP JSON-RPC call returns complete feature text in the same response", async () => {
  const { MCPServer } = await import("../mcp-protocol.ts");
  const old = globalThis.fetch;
  const full = JSON.stringify({
    summary: "Full originating-interface result 🌍 ".repeat(500),
    delivery: { complete: true },
  });
  let calls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) {
      return Response.json({ id: "personal-user" });
    }
    if (url.includes("/rest/v1/ns_tenant_memberships")) {
      return Response.json([]);
    }
    if (url.endsWith("/functions/v1/personal-capabilities")) {
      calls++;
      return new Response(full, {
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error("Unexpected endpoint");
  };
  try {
    const server = new MCPServer();
    const response = await server.handleHTTP(
      new Request("https://mcp.example/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-oauth",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 42,
          method: "tools/call",
          params: {
            name: "personal_capability",
            arguments: {
              operation: "invoke",
              conversation_key: "33333333-3333-4333-8333-333333333333",
              payload: { prompt: "Deep research: fixture", expectedVersion: 1 },
            },
          },
        }),
      }),
    );
    const result = await response.json();
    assertEquals(result.id, 42);
    assertEquals(result.result.content[0].text, full);
    assertEquals(calls, 1);
  } finally {
    globalThis.fetch = old;
  }
});
