import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { NeuralSynchClient } from "../supabase-client.ts";

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
