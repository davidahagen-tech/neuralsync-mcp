import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.0";
import { ALL_TOOLS_SCHEMA, MemoryToolHandler } from "../memory-tools.ts";
import { bindToolArguments } from "../auth.ts";

Deno.test("lifecycle transport preserves stable conversation and explicit cross-provider identity with user OAuth", async () => {
  const original = globalThis.fetch;
  const calls: any[] = [];
  globalThis.fetch = ((url: any, init: any) => {
    calls.push({
      url: String(url),
      headers: init.headers,
      body: JSON.parse(init.body),
    });
    return Promise.resolve(
      Response.json({
        session_id: "11111111-1111-4111-8111-111111111111",
        session_number: 445,
        status: "open",
      }),
    );
  }) as typeof fetch;
  try {
    for (const operation of ["open", "recover", "close"]) {
      const args = bindToolArguments("memory_session", {
        operation,
        conversation_key: "codex/chat-actual/phase-a",
        session_id: "11111111-1111-4111-8111-111111111111",
      }, {
        userId: "owner",
        accessToken: "user-oauth",
        tenantRoles: new Map([["viralbrain", "owner"]]),
      });
      const result = await new MemoryToolHandler().handleToolCall({
        name: "memory_session",
        arguments: args,
      });
      assertEquals(result.isError, undefined);
      assertEquals(JSON.parse(result.content[0].text).session_number, 445);
    }
    assertEquals(calls.length, 3);
    for (const c of calls) {
      assertStringIncludes(c.url, "/rpc/ns_working_session_v1");
      assertEquals(c.headers.Authorization, "Bearer user-oauth");
      assertEquals(c.body.p_conversation_key, "codex/chat-actual/phase-a");
      assertEquals(c.body.p_client_id, "viralbrain");
      assertEquals(c.body.p_session_id, "11111111-1111-4111-8111-111111111111");
    }
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("invalid boundaries and missing numeric identity fail before network; no timestamp fallback", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    throw Error("unexpected network");
  }) as typeof fetch;
  try {
    for (
      const args of [
        { operation: "open", conversation_key: "" },
        { operation: "advance", conversation_key: "a" },
        { operation: "open", conversation_key: " a" },
        { operation: "open", conversation_key: "a", session_id: "444" },
      ]
    ) {
      assertEquals(
        (await new MemoryToolHandler().handleToolCall({
          name: "memory_session",
          arguments: args,
        })).isError,
        true,
      );
    }
    for (const session_number of [undefined, 0, Date.now(), 1.5]) {
      assertEquals(
        (await new MemoryToolHandler().handleToolCall({
          name: "memory_write",
          arguments: {
            session_number,
            objective: "test",
            outcome_summary: "test",
          },
        })).isError,
        true,
      );
    }
    assertEquals(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("canonical session UUID reaches unchanged smart-close without client-side allocation", async () => {
  const original = globalThis.fetch;
  let body: any;
  globalThis.fetch = ((url: any, init: any) => {
    assertStringIncludes(String(url), "/neuralsync-smart-close");
    body = JSON.parse(init.body);
    return Promise.resolve(
      Response.json({ success: true, canonical_session_number: 445 }),
    );
  }) as typeof fetch;
  try {
    const args = bindToolArguments("memory_write", {
      session_number: 445,
      working_session_id: "11111111-1111-4111-8111-111111111111",
      objective: "test",
      outcome_summary: "test",
    }, {
      userId: "owner",
      accessToken: "user-oauth",
      tenantRoles: new Map([["viralbrain", "owner"]]),
    });
    assertEquals(
      (await new MemoryToolHandler().handleToolCall({
        name: "memory_write",
        arguments: args,
      })).isError,
      false,
    );
    assertEquals(body.working_session_id, args.working_session_id);
    assertEquals(body.session_number, 445);
    assertEquals(body.working_session_actor_id, undefined);
    assertEquals(ALL_TOOLS_SCHEMA.at(-1)?.name, "memory_session");
  } finally {
    globalThis.fetch = original;
  }
});
