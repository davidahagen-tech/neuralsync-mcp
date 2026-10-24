import type { MCPToolResult } from "./memory-tools.ts";
import {
  DEFAULT_SUPABASE_PUBLISHABLE_KEY,
  DEFAULT_SUPABASE_URL,
} from "./auth.ts";

export const WORK_EPISODE_SCHEMA = {
  name: "work_episode",
  description:
    "Explicit session/task associations in the existing Commitment Ledger. Use only canonical memory_session identities and authorized existing task IDs. link requires an open bound session, stable episode_id/request_id and current task expected_version. Repeat the same request on retry. task reads a task across sessions; session reads tasks in a bound session. Paginate using next_after. Revalidate current authority on every call. No task creation, execution, completion, automatic identity detection, or intelligence admission. Project comes from the task; optional record_ids reference already admitted relevant intelligence without copying or changing it. Association is not verified work evidence.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      client_id: { type: "string" },
      payload: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["link", "task", "session"] },
          episode_id: { type: "string", format: "uuid" },
          task_id: { type: "string", format: "uuid" },
          session_id: { type: "string", format: "uuid" },
          conversation_key: { type: "string", minLength: 1, maxLength: 200 },
          request_id: { type: "string", format: "uuid" },
          expected_version: { type: "integer", minimum: 1 },
          after: { type: "string", format: "uuid" },
          record_ids: {
            type: "array",
            maxItems: 20,
            items: { type: "string", format: "uuid" },
          },
        },
        required: ["action"],
      },
    },
    required: ["client_id", "payload"],
  },
};

export async function callWorkEpisode(
  args: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
): Promise<MCPToolResult> {
  if (
    Object.keys(args).some((k) => !["client_id", "payload"].includes(k)) ||
    typeof args.__access_token !== "string" ||
    typeof args.client_id !== "string"
  ) {
    throw Error("Authenticated tenant identity required");
  }
  const p = args.payload as Record<string, unknown>;
  if (
    !p || Array.isArray(p) ||
    !["link", "task", "session"].includes(String(p.action)) ||
    Object.keys(p).some((k) =>
      ![
        "action",
        "episode_id",
        "task_id",
        "session_id",
        "conversation_key",
        "request_id",
        "expected_version",
        "after",
        "record_ids",
      ].includes(k)
    )
  ) {
    throw Error("Explicit association operation required");
  }
  const { action, ...input } = p;
  const r = await fetcher(
    `${
      Deno.env.get("SUPABASE_URL") ?? DEFAULT_SUPABASE_URL
    }/rest/v1/rpc/ns_work_episode_v1`,
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
