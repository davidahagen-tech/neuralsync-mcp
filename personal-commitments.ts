import { callPersonalCapability } from "./personal-tools.ts";
import { TASK_SECRETARY_CONTRACT } from "./task-secretary-contract.ts";
import type { MCPToolResult } from "./memory-tools.ts";
export const PERSONAL_COMMITMENT_SCHEMA = {
  name: "personal_commitment",
  title: "NeuralSynch Task Secretary",
  description:
    "Read and update explicitly authorized durable assignments. Stable task IDs survive conversations. Use list/get before acting; reuse request_id on retries. A task grants no execution permission. External AI may report completion and evidence; only Owner review may verify or accept. The same ledger is available to explicitly qualified integrations for this Owner; unrelated histories and result files are not shared. This tool does not govern independent host actions or authorize background execution. " +
    TASK_SECRETARY_CONTRACT,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      conversation_key: { type: "string", format: "uuid" },
      payload: {
        type: "object",
        description:
          "action=list|get|create|transition|evidence|depend|execute|uncertain. All writes need request_id UUID; existing writes need id and expected_version from get. create needs id,title,description,project,executor,confirm_storage=true with explicit user consent. transition status=in_progress|blocked|reported_complete, optional note. evidence needs reference and optional sha256. depend needs dependency_id. execute needs prompt and expectedVersion from personal_capability session; uses existing Axiom/Bank/governance, never autonomous dispatch. uncertain records interrupted/unverifiable attempts; do not retry until Owner reconciliation.",
        properties: {
          action: { type: "string" },
          id: { type: "string" },
          request_id: { type: "string" },
          expected_version: { type: "integer" },
          title: { type: "string" },
          description: { type: "string" },
          project: { type: "string" },
          executor: { type: "string" },
          priority: { type: "string", enum: ["P0", "P1", "P2"] },
          include_archived: { type: "boolean" },
          confirm_storage: { type: "boolean" },
          status: { type: "string" },
          note: { type: "string" },
          reference: { type: "string" },
          sha256: { type: "string" },
          dependency_id: { type: "string" },
          prompt: { type: "string" },
          memory_id: { type: "string", format: "uuid" },
          expectedVersion: { type: "integer" },
          after: { type: "string" },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
    required: ["conversation_key", "payload"],
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};
export async function callPersonalCommitment(
  args: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
): Promise<MCPToolResult> {
  if (
    Object.keys(args).some((k) => !["conversation_key", "payload"].includes(k))
  ) throw Error("Client context rejected");
  const payload = args.payload as Record<string, unknown>;
  if (
    !payload ||
    ![
      "list",
      "get",
      "create",
      "transition",
      "evidence",
      "depend",
      "execute",
      "uncertain",
    ].includes(String(payload.action)) ||
    (payload.action === "transition" &&
      !["in_progress", "blocked", "reported_complete"].includes(
        String(payload.status),
      ))
  ) throw Error("Owner review required or invalid action");
  const bound = {
    operation: "commitment",
    conversation_key: args.conversation_key,
    payload,
  };
  Object.defineProperty(bound, "__access_token", {
    value: args.__access_token,
  });
  return callPersonalCapability(bound, fetcher);
}
