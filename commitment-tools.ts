import { PERSONAL_COMMITMENT_SCHEMA } from "./personal-commitments.ts";
import type { MCPToolResult } from "./memory-tools.ts";
import {
  DEFAULT_SUPABASE_PUBLISHABLE_KEY,
  DEFAULT_SUPABASE_URL,
} from "./auth.ts";
export const COMMITMENT_SCHEMA = {
  ...PERSONAL_COMMITMENT_SCHEMA,
  name: "commitment",
  title: "Organizational Task Secretary",
  description:
    "Read and update the one permanent Commitment Ledger across qualified ChatGPT, Claude and Codex connections. Server checks current OAuth, tenant membership, Owner pilot and client allowlist on every call. Read relevant tasks before acting. This grants no provider execution, file retrieval, verification or Owner acceptance. Do not infer tasks from ordinary conversation.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      client_id: {
        type: "string",
        description:
          "Exact enrolled organization client ID; existing tenant admission is required.",
      },
      payload: {
        ...PERSONAL_COMMITMENT_SCHEMA.inputSchema.properties.payload,
        description:
          "Metadata actions: list/get/create/transition/evidence/depend/uncertain. Read current version before mutation. Writes require request_id; existing writes require expected_version. No execution, file retrieval, verification, acceptance or deletion.",
        properties: Object.fromEntries(
          Object.entries(
            PERSONAL_COMMITMENT_SCHEMA.inputSchema.properties.payload
              .properties,
          ).filter(([key]) =>
            !["prompt", "memory_id", "expectedVersion"].includes(key)
          ),
        ),
      },
    },
    required: ["client_id", "payload"],
  },
};
export async function callCommitment(
  args: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
): Promise<MCPToolResult> {
  if (
    Object.keys(args).some((k) => !["client_id", "payload"].includes(k)) ||
    typeof args.__access_token !== "string" ||
    typeof args.client_id !== "string"
  ) throw Error("Authenticated tenant identity required");
  const p = args.payload as Record<string, unknown>;
  if (
    !p ||
    !["list", "get", "create", "transition", "evidence", "depend", "uncertain"]
      .includes(String(p.action)) ||
    (p.action === "transition" &&
      !["in_progress", "blocked", "reported_complete"].includes(
        String(p.status),
      ))
  ) throw Error("Metadata operation only; Owner review required");
  const { action, ...input } = p;
  const r = await fetcher(
    `${
      Deno.env.get("SUPABASE_URL") ?? DEFAULT_SUPABASE_URL
    }/rest/v1/rpc/ns_commitment_connector_v1`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.__access_token}`,
        apikey: Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ??
          Deno.env.get("SUPABASE_ANON_KEY") ?? DEFAULT_SUPABASE_PUBLISHABLE_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_client_id: args.client_id,
        p_operation: action,
        p_input: input,
      }),
    },
  );
  return { content: [{ type: "text", text: await r.text() }], isError: !r.ok };
}
