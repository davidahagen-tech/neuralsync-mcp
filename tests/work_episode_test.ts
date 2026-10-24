import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@^1.0.0";
import { bindToolArguments } from "../auth.ts";
import { callWorkEpisode, WORK_EPISODE_SCHEMA } from "../work-episode-tools.ts";

const principal = {
  userId: "fixture-owner",
  accessToken: "synthetic-token",
  tenantRoles: new Map([["fixture.one", "owner"]]),
};
const payload = {
  action: "link",
  episode_id: "episode",
  session_id: "session",
  task_id: "task",
  conversation_key: "explicit-key",
  request_id: "request",
  expected_version: 7,
};

Deno.test("association adapter preserves authenticated request and complete error evidence without retries", async () => {
  for (const status of [200, 409, 403, 500]) {
    let calls = 0;
    const body = JSON.stringify({
      link: { id: "stable-id" },
      replayed: status === 200,
      errors: status === 200 ? [] : ["denied"],
    });
    const result = await callWorkEpisode(
      bindToolArguments(
        "work_episode",
        { client_id: "fixture.one", payload },
        principal,
      ),
      async (url, init) => {
        calls++;
        assertEquals(String(url).endsWith("/rpc/ns_work_episode_v1"), true);
        assertEquals(
          new Headers(init?.headers).get("Authorization"),
          "Bearer synthetic-token",
        );
        const { action, ...input } = payload;
        assertEquals(JSON.parse(String(init?.body)), {
          p_client_id: "fixture.one",
          p_operation: action,
          p_input: input,
        });
        return new Response(body, { status });
      },
    );
    assertEquals(calls, 1);
    assertEquals(result, {
      content: [{ type: "text", text: body }],
      isError: status !== 200,
    });
  }
});

Deno.test("association adapter cannot forge bearer, tenant, authority, or dispatch execution", async () => {
  assertThrows(() =>
    bindToolArguments(
      "work_episode",
      { client_id: "other", payload },
      principal,
    )
  );
  for (
    const p of [{ ...payload, action: "execute" }, {
      ...payload,
      owner_id: "other",
    }, { ...payload, status: "accepted" }]
  ) {
    await assertRejects(() =>
      callWorkEpisode(
        bindToolArguments("work_episode", {
          client_id: "fixture.one",
          payload: p,
        }, principal),
        () => {
          throw Error("must not dispatch");
        },
      )
    );
  }
  await assertRejects(() =>
    callWorkEpisode({
      client_id: "fixture.one",
      payload,
      __access_token: "forged",
    })
  );
  assertEquals(
    JSON.stringify(WORK_EPISODE_SCHEMA).includes("__access_token"),
    false,
  );
});
