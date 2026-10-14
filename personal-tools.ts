import {
  DEFAULT_SUPABASE_PUBLISHABLE_KEY,
  DEFAULT_SUPABASE_URL,
} from "./auth.ts";
import type { MCPToolResult } from "./memory-tools.ts";

export const PERSONAL_TOOLS_SCHEMA = [{
  name: "personal_capability",
  description:
    "Invoke the same governed NeuralSynch Personal capabilities used by Axiom and return the complete result here. Requires a qualified OAuth client and current Personal entitlement. First use session with a stable conversation_key UUID. invoke accepts prompt and expectedVersion for Recall, Related, Predict, Research, Deep Research, Verify, Challenger, Humanizer, Intelligence Update and Visualize. Preserve the same expectedVersion on a retry; result recovers without provider execution or NUU debit. concept develops versioned Concept Lab workspaces for Personal and higher applicable plans, with explicit assessment and customer decisions. report, intake and save reuse their existing explicit governed contracts; a job status is not its completed output. After a completed invocation, use personal_result with its delivery.request_key to open the complete verified hosted viewer without model-side assembly. Never present a partial/status response as a complete result. Does not grant authority, activate a trial or admit intelligence without explicit consent.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      operation: {
        type: "string",
        enum: ["session", "invoke", "result", "report", "intake", "save", "concept"],
      },
      conversation_key: {
        type: "string",
        description:
          "Stable UUID for this originating conversation. Reuse it for invocation, recovery and retries.",
      },
      payload: {
        type: "object",
        description:
          "Unmodified input for the existing Personal capability contract; no user, tenant, Origin or credentials. Session accepts {}. concept uses the native Concept Lab contract: action=list|get|create|revise|refresh|archive|abandon|step|export|save; always include expectedVersion from the latest session. create requires id UUID, title, brief {idea,kind,objective,audience,constraints,direction}, fields {value,state:open|draft|locked}, and explicit confirm_workspace_storage=true. step requires id,version,request_id UUID,step=assess|discuss|market|research|deep_research|challenge|verify|humanizer|related|predict|blueprint; discuss and humanizer require question; related/predict require memory_id. Reuse request_id on retries. Blueprint advances one saved group per call until complete. For customer delivery call personal_result with conversation_key,concept_id=id,version; the hosted viewer retrieves exact canonical/Word/PDF bytes without sending document base64 through the model. Native export requires id,version,format=canonical|docx|pdf. Revise requires expected_revision and complete customer-approved brief; never adopt recommendations automatically. save requires explicit confirm_durable_admission=true and request_id. get uses id and optional version. invoke: prompt, expectedVersion, optional memory_id. result: optional request_key; optional offset and limit (1..16000 Unicode characters) provide lossless continuation for large outputs. Reuse delivery.request_key for every later chunk; concatenate transfer.text in offset order and verify delivery.sha256 over UTF-8. Partial transfer is not complete output. report uses action/job_id/expectedVersion and native create/draft/compile/advance/present/status/preview/retrieve inputs; review/release/revoke are forbidden. intake uses its existing action/job_id/source_id/consent contract. save accepts action=remember, request_id, title, body, subject_key, and explicit confirm_durable_admission=true; no source-consent changes.",
      },
    },
    required: ["operation", "conversation_key", "payload"],
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
}];

export async function callPersonalCapability(
  args: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
): Promise<MCPToolResult> {
  const token = args.__access_token;
  if (typeof token !== "string" || !token) {
    throw new Error("Authenticated Personal OAuth session required.");
  }
  if (
    Object.keys(args).some((k) =>
      !["operation", "conversation_key", "payload"].includes(k)
    )
  ) throw new Error("Client context rejected.");
  const base = Deno.env.get("SUPABASE_URL") ?? DEFAULT_SUPABASE_URL;
  const key = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ??
    Deno.env.get("SUPABASE_ANON_KEY") ?? DEFAULT_SUPABASE_PUBLISHABLE_KEY;
  const response = await fetcher(`${base}/functions/v1/personal-capabilities`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      operation: args.operation,
      conversation_key: args.conversation_key,
      payload: args.payload,
    }),
  });
  const type = response.headers.get("Content-Type") ??
    "application/octet-stream";
  if (type.includes("json") || type.startsWith("text/")) {
    // Deliberately no slice, preview, summary fallback, or retry on ambiguity.
    return {
      content: [{ type: "text", text: await response.text() }],
      isError: !response.ok,
    };
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  let raw = "";
  for (let i = 0; i < bytes.length; i += 16384) {
    raw += String.fromCharCode(...bytes.subarray(i, i + 16384));
  }
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  ).map((v) => v.toString(16).padStart(2, "0")).join("");
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        schema: "neuralsynch.result.artifact.v1",
        media_type: type,
        byte_length: bytes.length,
        sha256: digest,
        encoding: "base64",
        data: btoa(raw),
        complete: true,
      }),
    }],
    isError: !response.ok,
  };
}
