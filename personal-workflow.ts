import { callPersonalCapability } from "./personal-tools.ts";
import {
  blueprintRequestId,
  conceptWorkflow,
  type ConceptWorkflowState,
} from "./workflow.ts";
import { RESULT_RESOURCE } from "./result-view.ts";
import type { MCPToolResult } from "./memory-tools.ts";

export const PERSONAL_WORKFLOW_SCHEMA = {
  name: "personal_workflow",
  title: "NeuralSynch workflow tracker",
  description:
    "Open the NeuralSynch Blueprint workflow tracker in this originating conversation. status reads saved progress without AI calls or Capacity debit. The customer can initiate remaining Blueprint groups and document preparation once in the viewer; it advances existing governed stages automatically. advance performs only the requested stage after rechecking saved state, authorization and Capacity; use only for an explicitly customer-authorized Blueprint build. Never auto-assess, research, or adopt recommendations. On interruption stop and recover status. A host without MCP Apps must show the returned text status and can advance authorized stages using the same stage token; never claim background execution or complete delivery without the complete-result viewer.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      conversation_key: { type: "string", format: "uuid" },
      concept_id: { type: "string", format: "uuid" },
      version: { type: "integer", minimum: 1 },
      action: { type: "string", enum: ["status", "advance"] },
      stage: {
        type: "string",
        enum: [
          "blueprint:0",
          "blueprint:1",
          "blueprint:2",
          "blueprint:3",
          "documents",
        ],
      },
    },
    required: ["conversation_key", "concept_id", "version", "action"],
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  _meta: {
    ui: { resourceUri: RESULT_RESOURCE.uri, visibility: ["model", "app"] },
  },
};
export async function callPersonalWorkflow(
  args: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
): Promise<MCPToolResult> {
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const fail = (code: string): MCPToolResult => ({
    content: [{
      type: "text",
      text: JSON.stringify({
        code,
        recovery:
          "Stop. Recover saved status before continuing; completed work remains in custody.",
      }),
    }],
    isError: true,
  });
  if (
    Object.keys(args).some((k) =>
      !["conversation_key", "concept_id", "version", "action", "stage"]
        .includes(k)
    ) || !uuid.test(String(args.conversation_key)) ||
    !uuid.test(String(args.concept_id)) ||
    !Number.isSafeInteger(args.version) || Number(args.version) < 1 ||
    !["status", "advance"].includes(String(args.action)) ||
    typeof args.__access_token !== "string" ||
    (args.action === "advance" &&
      !/^(blueprint:[0-3]|documents)$/.test(String(args.stage))) ||
    (args.action === "status" && args.stage !== undefined)
  ) return fail("WORKFLOW_CONTEXT_REJECTED");
  const call = async (operation: string, payload: Record<string, unknown>) => {
    const bound = {
      operation,
      conversation_key: args.conversation_key,
      payload,
    };
    Object.defineProperty(bound, "__access_token", {
      value: args.__access_token,
    });
    const r = await callPersonalCapability(bound, fetcher);
    if (r.isError) throw Error("WORKFLOW_PAUSED");
    return JSON.parse(r.content[0].text);
  };
  try {
    let session = (await call("session", {})).session;
    const base = { id: args.concept_id, version: args.version };
    const read = async () => {
      const r = await call("concept", {
        ...base,
        action: "get",
        expectedVersion: session.stateVersion,
      });
      const w = r.workspace as ConceptWorkflowState;
      if (
        !w || w.project.id !== args.concept_id ||
        w.version.version !== args.version || !Array.isArray(w.steps) ||
        w.steps.some((s) => s.status === "withheld")
      ) throw Error("WORKFLOW_WITHHELD");
      if (r.session) session = r.session;
      return w;
    };
    let w = await read();
    const next = (w: ConceptWorkflowState) => {
      const group = [0, 1, 2, 3].find((i) =>
        !w.steps.some((s) =>
          s.step === `blueprint:${i}` && s.status === "complete"
        )
      );
      return group !== undefined
        ? `blueprint:${group}`
        : conceptWorkflow(w).state === "complete"
        ? null
        : "documents";
    };
    if (args.action === "advance" && args.stage === next(w)) {
      if (conceptWorkflow(w).state === "blocked" || w.steps.some(s=>s.status=== "failed")) {
        throw Error("WORKFLOW_WITHHELD");
      }
      const r = await call(
        "concept",
        args.stage === "documents"
          ? {
            ...base,
            action: "export",
            format: "canonical",
            expectedVersion: session.stateVersion,
          }
          : {
            ...base,
            action: "step",
            step: "blueprint",
            request_id: await blueprintRequestId(w),
            expectedVersion: session.stateVersion,
          },
      );
      if (r.session) session = r.session;
      w = await read();
      if (args.stage === next(w)) throw Error("WORKFLOW_PAUSED");
    }
    const snapshot = conceptWorkflow(w);
    const manifest = {
      schema: "neuralsynch.workflow.v1",
      conversation_key: args.conversation_key,
      concept_id: args.concept_id,
      version: args.version,
      next_stage: next(w),
      snapshot,
    };
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ...manifest,
          note:
            "Saved progress, not a completed Blueprint. Open the workflow viewer to build or recover. Document delivery uses personal_result.",
        }),
      }],
      structuredContent: manifest,
      _meta: { "neuralsynch/workflow": { ...manifest, workspace: w } },
    };
  } catch (e) {
    return fail(
      e instanceof Error && e.message === "WORKFLOW_WITHHELD"
        ? e.message
        : "WORKFLOW_PAUSED",
    );
  }
}
