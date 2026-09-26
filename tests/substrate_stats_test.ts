import { assertEquals, assertThrows } from "jsr:@std/assert@^1.0.0";
import { NeuralSynchClient } from "../supabase-client.ts";
import { bindToolArguments } from "../auth.ts";

Deno.test("packet read preserves requested session and safely encodes bank alias", async () => {
  const old = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assertEquals(url.searchParams.get("client_id"), "bank&alias");
    assertEquals(url.searchParams.get("session_number"), "432");
    return Response.json({ success: true, session_number: 432 });
  };
  try {
    const result = await new NeuralSynchClient().readMemoryPacket("bank&alias", "synthetic-token", 432);
    assertEquals(result.session_number, 432);
  } finally { globalThis.fetch = old; }
});

for (const [label, response, expected] of [
  ["verified populated bank", () => Response.json({ state: "verified", ns_records: 4950, memory_records: 4950, session_writebacks: 1556, locked_decisions: 1392 }), "verified"],
  ["verified empty bank", () => Response.json({ state: "no_records", ns_records: 0, memory_records: 0, session_writebacks: 0, locked_decisions: 0 }), "no_records"],
  ["denial", () => new Response("denied", { status: 403 }), "access_denied"],
  ["upstream failure", () => new Response("failed", { status: 503 }), "upstream_error"],
  ["malformed successful response", () => Response.json({}), "upstream_error"],
  ["false healthy zero", () => Response.json({state:"verified",ns_records:0,session_writebacks:0,locked_decisions:0}), "upstream_error"],
] as const) {
  Deno.test(`statistics: ${label}`, async () => {
    const old = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      assertEquals(String(url).endsWith("/rpc/ns_substrate_stats_v1"), true);
      assertEquals(JSON.parse(String(init?.body)), {p_client_id:"neuralsynch"});
      return response();
    };
    try {
      const result = await new NeuralSynchClient().getMemoryStats("neuralsynch", "synthetic-token");
      assertEquals(result.state, expected);
      if (expected === "access_denied" || expected === "upstream_error") assertEquals(result.ns_records, null);
    } finally { globalThis.fetch = old; }
  });
}
Deno.test("memory aliases never expand custody authority", () => {
  const principal={userId:"synthetic",accessToken:"test",tenantRoles:new Map([["original","owner"]]),substrateRoles:new Map([["renamed","owner"]])};
  assertEquals(bindToolArguments("memory_read",{client_id:"renamed"},principal).client_id,"renamed");
  assertThrows(()=>bindToolArguments("custody_store",{client_id:"renamed"},principal));
  assertThrows(()=>bindToolArguments("memory_read",{client_id:"typo"},principal));
});
