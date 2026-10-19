import { assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import { callPersonalCommitment } from "../personal-commitments.ts";
import { bindToolArguments } from "../auth.ts";
const key = "33333333-3333-4333-8333-333333333333";
const principal = {
  userId: "owner",
  accessToken: "synthetic-oauth",
  tenantRoles: new Map<string, string>(),
};
Deno.test("task adapter preserves OAuth bearer, stable request and entire result without a model", async () => {
  const payload = {
    action: "create",
    id: key,
    request_id: key,
    title: "Explicit task",
    description: "Owner criteria",
    project: "Pilot",
    executor: "Codex",
    confirm_storage: true,
  };
  let calls = 0;
  const r = await callPersonalCommitment(
    bindToolArguments(
      "personal_commitment",
      { conversation_key: key, payload },
      principal,
    ),
    async (_url, init) => {
      calls++;
      assertEquals(
        new Headers(init?.headers).get("Authorization"),
        "Bearer synthetic-oauth",
      );
      const b = JSON.parse(String(init?.body));
      assertEquals(b.operation, "commitment");
      assertEquals(b.payload, payload);
      return Response.json({ task: { id: key, status: "assigned" } });
    },
  );
  assertEquals(calls, 1);
  assertEquals(r.isError, false);
  assertEquals(JSON.stringify(r).includes(key), true);
});
Deno.test("external task adapter rejects Owner acceptance and sharing without dispatch", async () => {
  for (
    const payload of [
      { action: "transition", status: "accepted" },
      { action: "share" },
      { action: "reconcile" },
      { action: "reassign" },
    ]
  ) {
    await assertRejects(() =>
      callPersonalCommitment(
        bindToolArguments("personal_commitment", {
          conversation_key: key,
          payload,
        }, principal),
        () => {
          throw Error("must not dispatch");
        },
      )
    );
  }
});

import { callCommitment } from "../commitment-tools.ts";
for (const provider of ["ChatGPT", "Claude", "Codex"]) {
  Deno.test(`${provider} organizational metadata adapter uses existing tenant-bound OAuth path`, async () => {
    const p = {
      userId: "owner",
      accessToken: `synthetic-${provider}`,
      tenantRoles: new Map([["fixture.one", "owner"]]),
    };
    let calls = 0;
    const args = bindToolArguments("commitment", {
      client_id: "fixture.one",
      payload: { action: "get", id: key },
    }, p);
    const r = await callCommitment(args, async (url, init) => {
      calls++;
      assertEquals(
        String(url).endsWith("/rpc/ns_commitment_connector_v1"),
        true,
      );
      assertEquals(
        new Headers(init?.headers).get("Authorization"),
        `Bearer synthetic-${provider}`,
      );
      assertEquals(JSON.parse(String(init?.body)), {
        p_client_id: "fixture.one",
        p_operation: "get",
        p_input: { id: key },
      });
      return Response.json({ task: { id: key } });
    });
    assertEquals(calls, 1);
    assertEquals(r.isError, false);
  });
}
