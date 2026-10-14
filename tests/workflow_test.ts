import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { callPersonalWorkflow } from "../personal-workflow.ts";
import { bindToolArguments } from "../auth.ts";
const id = "11111111-1111-4111-8111-111111111111",
  conversation_key = "33333333-3333-4333-8333-333333333333";
const principal = {
  userId: "u",
  accessToken: "test-oauth",
  tenantRoles: new Map<string, string>(),
};
function fixture(mode = "ok") {
  const w: any = {
    project: { id, revision: 1 },
    version: { version: 1, artifacts: {} },
    steps: [],
  };
  let writes = 0, reads = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    const b = JSON.parse(String(init?.body));
    assertEquals(
      new Headers(init?.headers).get("Authorization"),
      "Bearer test-oauth",
    );
    if (b.operation === "session") {
      return Response.json({ session: { stateVersion: 2 } });
    }
    const p = b.payload;
    assertEquals(p.id, id);
    assertEquals(p.version, 1);
    if (p.action === "get") {
      reads++;
      return Response.json({
        workspace: mode === "revoked"
          ? { ...w, steps: [{ status: "withheld" }] }
          : w,
        session: { stateVersion: 2 },
      });
    }
    writes++;
    if (mode === "capacity") {
      return Response.json({ code: "CAPACITY_DENIED" }, { status: 403 });
    }
    if (p.action === "step") {
      w.steps.push({
        id: p.request_id,
        step: "blueprint:" + w.steps.length,
        status: "complete",
        response: {
          concept: {
            sections: [{ heading: "Saved section", body: "Exact text" }],
          },
        },
      });
      return Response.json({ session: { stateVersion: 2 } });
    }
    assertEquals(p.action, "export");
    w.version.artifacts = { canonical: {}, pdf: {}, docx: {} };
    return Response.json({ title: "Exact document" });
  };
  const call = (action: string, stage?: string) =>
    callPersonalWorkflow(
      bindToolArguments("personal_workflow", {
        conversation_key,
        concept_id: id,
        version: 1,
        action,
        ...(stage ? { stage } : {}),
      }, principal),
      fetcher,
    );
  return { call, w, writes: () => writes, reads: () => reads };
}
Deno.test("workflow status never generates or compiles; five exact stages complete; stale stage retry is read only", async () => {
  const f = fixture();
  const status = await f.call("status");
  assertEquals(f.writes(), 0);
  assertEquals(status.structuredContent?.next_stage, "blueprint:0");
  for (
    const stage of [
      "blueprint:0",
      "blueprint:1",
      "blueprint:2",
      "blueprint:3",
      "documents",
    ]
  ) {
    const r = await f.call("advance", stage);
    assertEquals(r.isError, undefined);
    await f.call("advance", stage);
  }
  assertEquals(f.writes(), 5);
  const r = await f.call("status");
  assertEquals((r.structuredContent?.snapshot as any).state, "complete");
  assertEquals(r.content[0].text.includes("Exact text"), false);
});
for (const mode of ["revoked", "capacity"]) {
  Deno.test("workflow fail closed " + mode, async () => {
    const f = fixture(mode);
    const r = await f.call("advance", "blueprint:0");
    assertEquals(r.isError, true);
    assertEquals(r._meta, undefined);
    assertEquals(f.writes(), mode === "revoked" ? 0 : 1);
  });
}
Deno.test("workflow rejects identity spoofing and advancing an old version", async () => {
  const f = fixture();
  f.w.project.revision = 2;
  assertEquals((await f.call("advance", "blueprint:0")).isError, true);
  assertEquals(f.writes(), 0);
  const r = await callPersonalWorkflow(
    bindToolArguments("personal_workflow", {
      conversation_key,
      concept_id: id,
      version: 1,
      action: "status",
      client_id: "spoof",
    }, principal),
  );
  assertEquals(r.isError, true);
});
