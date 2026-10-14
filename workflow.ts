/** Presentation contract shared with the MCP Apps tracker. No clocks, estimates,
 * provider calls, or authority decisions belong in a workflow projection. */
export interface WorkflowSnapshot {
  title: string;
  activity: string;
  recovery: string;
  state: "ready" | "running" | "paused" | "blocked" | "complete";
  milestones: {
    id: string;
    label: string;
    state: "complete" | "active" | "upcoming";
  }[];
}
export interface ConceptWorkflowState {
  project: { id: string; revision: number };
  version: { version: number; artifacts?: Record<string, unknown> };
  steps: { id: string; step: string; status: string }[];
}
const labels = [
  "Brief",
  "Foundation",
  "Alternatives",
  "Development",
  "Decisions",
  "Word / PDF",
];
export function conceptWorkflow(
  w: ConceptWorkflowState,
  running = false,
  interrupted = false,
): WorkflowSnapshot {
  const denied = w.steps.some((s) => s.status === "withheld") ||
    w.project.revision !== w.version.version;
  const done = [
    true,
    ...[0, 1, 2, 3].map((i) =>
      w.steps.some((s) =>
        s.step === `blueprint:${i}` && s.status === "complete"
      )
    ),
    ["canonical", "docx", "pdf"].every((f) => !!w.version.artifacts?.[f]),
  ];
  const next = done.findIndex((v) => !v);
  const pending = w.steps.some((s) => s.status === "pending");
  const state = denied
    ? "blocked"
    : next < 0
    ? "complete"
    : running
    ? "running"
    : pending || interrupted
    ? "paused"
    : "ready";
  return {
    title: "Your Concept Blueprint",
    state,
    activity: denied
      ? "Access or version changed — review required"
      : next < 0
      ? "Blueprint and documents saved"
      : running
      ? `Building ${labels[next].toLowerCase()}`
      : pending
      ? "A saved step needs recovery"
      : interrupted
      ? "Paused — recover before continuing"
      : `Ready for ${labels[next].toLowerCase()}`,
    recovery: denied
      ? "Generated work is withheld until access is restored"
      : pending
      ? "Completed work saved · pending result needs checking"
      : "Completed work saved · recoverable in this workspace",
    milestones: labels.map((label, i) => ({
      id: String(i),
      label,
      state: denied
        ? "upcoming"
        : done[i]
        ? "complete"
        : running && i === next
        ? "active"
        : "upcoming",
    })),
  };
}
/** A stable request ID allows a lost response to recover the original stage.
 * Existing server claims, source checks, and Capacity reservations remain final. */
export async function blueprintRequestId(
  w: ConceptWorkflowState,
): Promise<string> {
  const pending = w.steps.find((s) => s.status === "pending");
  if (pending) {
    if (!pending.step.startsWith("blueprint:")) {
      throw Error(
        "Recover the pending activity before building the Blueprint.",
      );
    }
    return pending.id;
  }
  const group = [0, 1, 2, 3].find((i) =>
    !w.steps.some((s) => s.step === `blueprint:${i}` && s.status === "complete")
  );
  const abandoned = w.steps.filter((s) =>
    s.step === `blueprint:${group}` && s.status === "abandoned"
  ).map((s) => s.id).sort().join(",");
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `ns-blueprint:${w.project.id}:${w.version.version}:${group}:${abandoned}`,
      ),
    ),
  );
  digest[6] = (digest[6] & 15) | 80;
  digest[8] = (digest[8] & 63) | 128;
  const h = Array.from(
    digest.slice(0, 16),
    (v) => v.toString(16).padStart(2, "0"),
  ).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${
    h.slice(16, 20)
  }-${h.slice(20)}`;
}
/** One customer initiation authorizes remaining Blueprint groups and document
 * preparation only. Stop on ambiguity; never retry a provider in a timer. */
export async function buildBlueprint(port: {
  read: () => Promise<ConceptWorkflowState>;
  step: (requestId: string) => Promise<void>;
  compile: () => Promise<void>;
  update: (w: ConceptWorkflowState, running: boolean) => void;
  stopped: () => boolean;
}) {
  let w = await port.read();
  for (let n = 0; n < 5; n++) {
    const view = conceptWorkflow(w);
    if (view.state === "blocked") throw Error(view.activity);
    port.update(w, false);
    if (view.state === "complete" || port.stopped()) return;
    const before = JSON.stringify(w.steps.map((s) => [s.id, s.status]));
    port.update(w, true);
    if (view.milestones.slice(1, 5).every((s) => s.state === "complete")) {
      await port.compile();
    } else await port.step(await blueprintRequestId(w));
    w = await port.read();
    port.update(w, false);
    if (conceptWorkflow(w).state === "complete") return;
    if (before === JSON.stringify(w.steps.map((s) => [s.id, s.status]))) {
      throw Error(
        "Stage not complete. Recover the saved result before continuing.",
      );
    }
  }
}
