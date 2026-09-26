import { callPersonalCapability } from "./personal-tools.ts";
import type { MCPToolResult } from "./memory-tools.ts";
import { RESULT_RESOURCE } from "./result-view.ts";

export const PERSONAL_RESULT_SCHEMA = {
  name: "personal_result",
  title: "Open complete NeuralSynch result",
  description:
    "Use this after a completed Personal capability invocation, or to recover that result in this conversation. Opens the full byte-verified result inside the hosted interface using the shared NeuralSynch viewer. Rechecks current session, source and authority; never executes a provider or debits NUU. Reuse the original conversation_key and delivery.request_key. The complete bytes go directly to the viewer; do not reconstruct them from model text. A client without MCP Apps support has not established complete hosted delivery.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      conversation_key: { type: "string", format: "uuid" },
      request_key: { type: "string", minLength: 1 },
    },
    required: ["conversation_key", "request_key"],
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  _meta: {
    ui: { resourceUri: RESULT_RESOURCE.uri, visibility: ["model", "app"] },
  },
};

const encoder = new TextEncoder();
export async function callPersonalResult(
  args: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
): Promise<MCPToolResult> {
  const denied = (code: string): MCPToolResult => ({
    content: [{ type: "text", text: JSON.stringify({ code }) }],
    isError: true,
  });
  if (
    Object.keys(args).some((k) =>
      !["conversation_key", "request_key"].includes(k)
    ) ||
    typeof args.conversation_key !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      args.conversation_key,
    ) ||
    typeof args.request_key !== "string" || !args.request_key ||
    args.request_key.length > 200 || typeof args.__access_token !== "string"
  ) return denied("CLIENT_CONTEXT_REJECTED");
  const page = async (offset: number, limit = 16000) => {
    const bound = {
      operation: "result",
      conversation_key: args.conversation_key,
      payload: { request_key: args.request_key, offset, limit },
    };
    Object.defineProperty(bound, "__access_token", {
      value: args.__access_token,
    });
    const r = await callPersonalCapability(bound, fetcher);
    if (r.isError) throw new Error("RESULT_WITHHELD");
    return JSON.parse(r.content[0].text);
  };
  try {
    let offset = 0, text = "", first: any;
    for (let n = 0; n < 512; n++) {
      const p = await page(offset), t = p.transfer, d = p.delivery;
      if (!first) first = p;
      if (
        !d?.complete || d.request_key !== args.request_key ||
        !/^[a-f0-9]{64}$/.test(d.sha256) ||
        !Number.isSafeInteger(d.byte_length) || d.byte_length < 1 ||
        d.byte_length > 8 * 1024 * 1024 ||
        JSON.stringify(d) !== JSON.stringify(first.delivery) ||
        p.origin !== first.origin ||
        p.conversation_key !== args.conversation_key ||
        t?.encoding !== "unicode-characters" || t.offset !== offset ||
        t.total_characters !== first.transfer.total_characters ||
        typeof t.text !== "string"
      ) throw new Error("RESULT_INTEGRITY_FAILED");
      text += t.text;
      offset += Array.from(t.text).length;
      if (encoder.encode(text).length > d.byte_length) {
        throw new Error("RESULT_INTEGRITY_FAILED");
      }
      if (t.next_offset === null) {
        if (offset !== t.total_characters) {
          throw new Error("RESULT_INTEGRITY_FAILED");
        }
        const bytes = encoder.encode(text);
        const sha256 = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        ).map((x) => x.toString(16).padStart(2, "0")).join("");
        if (bytes.length !== d.byte_length || sha256 !== d.sha256) {
          throw new Error("RESULT_INTEGRITY_FAILED");
        }
        // Final fresh canonical read: changes during assembly withhold the entire result.
        const final = await page(0, 1);
        if (
          JSON.stringify(final.delivery) !== JSON.stringify(d) ||
          final.origin !== first.origin
        ) throw new Error("RESULT_WITHHELD");
        const manifest = {
          schema: "neuralsynch.hosted-result.v1",
          conversation_key: args.conversation_key,
          delivery: d,
          automation: final.automation,
          transport_verified: true,
        };
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ...manifest,
              presentation:
                "Complete result supplied directly to the hosted viewer. Viewer verifies bytes independently; do not infer rendered success from this receipt alone.",
            }),
          }],
          structuredContent: manifest,
          _meta: { "neuralsynch/result": { ...manifest, payload: text } },
        };
      }
      if (t.next_offset !== offset || !t.text) {
        throw new Error("RESULT_INTEGRITY_FAILED");
      }
    }
    return denied("RESULT_TRANSFER_LIMIT");
  } catch (e) {
    return denied(
      e instanceof Error && e.message === "RESULT_INTEGRITY_FAILED"
        ? e.message
        : "RESULT_WITHHELD",
    );
  }
}
