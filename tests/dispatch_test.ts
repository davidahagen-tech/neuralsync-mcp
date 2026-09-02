// Dispatch and record-retrieval tests.
//
// Covers the routing guarantee for all 17 tools (no tool falls through to
// "Unknown tool"), the UUID-aware `fetch` correction, and get_record_by_id's
// fail-closed behaviour. Offline: fetch is stubbed.
//
// Run: deno test --allow-env tests/dispatch_test.ts

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "jsr:@std/assert@^1.0.0";
import {
  ALL_TOOLS_SCHEMA,
  isRecordId,
  MemoryToolHandler,
} from "../memory-tools.ts";
import { CUSTODY_KEY_ENV } from "../custody-tools.ts";

const REAL_UUID = "adc677c6-e9c0-40c9-a7e1-ddd6481acd5c";

const RECORD_ROW = {
  id: REAL_UUID,
  title: "NeuralSynch Master-AI Artifact Custody — Operating Instructions",
  body: "FULL BODY LINE 1\n".repeat(400),
  content_type: "runbook",
  domain: "custody",
  status: "active",
  session_number: 251,
  tags: ["custody"],
  attributes: {},
  created_at: "2026-08-05T20:00:00Z",
  client_id: "neuralsynch",
};

/** Stub fetch with a router keyed on URL substring. */
function stubFetch(routes: Array<[string, unknown]>, fallback: unknown = []) {
  const urls: string[] = [];
  const original = globalThis.fetch;
  const originalServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
  globalThis.fetch = ((url: any) => {
    const u = String(url);
    urls.push(u);
    for (const [needle, body] of routes) {
      if (u.includes(needle)) {
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
    }
    return Promise.resolve(
      new Response(JSON.stringify(fallback), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return {
    urls,
    restore: () => {
      globalThis.fetch = original;
      if (originalServiceKey === undefined) {
        Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
      } else {
        Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", originalServiceKey);
      }
    },
  };
}

// ─── isRecordId ────────────────────────────────────────────────────────

Deno.test("isRecordId accepts a UUID and rejects a client_id", () => {
  assert(isRecordId(REAL_UUID));
  assert(isRecordId(REAL_UUID.toUpperCase()));
  assert(
    isRecordId(`  ${REAL_UUID}  `),
    "surrounding whitespace should be tolerated",
  );

  assert(!isRecordId("viralbrain"));
  assert(!isRecordId("neuralsynch"));
  assert(!isRecordId(""));
  assert(!isRecordId(undefined));
  assert(!isRecordId(12345));
  assert(
    !isRecordId(`prefix-${REAL_UUID}`),
    "must be anchored, not a substring match",
  );
  assert(
    !isRecordId(`${REAL_UUID}-suffix`),
    "must be anchored, not a substring match",
  );
});

// ─── dispatch coverage ─────────────────────────────────────────────────

Deno.test("every advertised tool has a dispatch case — none falls through", async () => {
  const stub = stubFetch([
    ["/rest/v1/ns_records", [RECORD_ROW]],
    ["/functions/v1/neuralsync-custody", {
      ok: true,
      result: { verified: true, version_id: "v" },
    }],
    ["/functions/v1/retrieve-context-packet", {
      context_prompt: "x",
      session_number: 1,
    }],
    ["/rest/v1/rpc/", []],
  ]);
  const handler = new MemoryToolHandler();
  Deno.env.set(CUSTODY_KEY_ENV, "nsck_" + "b".repeat(64));
  try {
    for (const tool of ALL_TOOLS_SCHEMA as any[]) {
      const args: Record<string, unknown> = {};
      args.__access_token = "test-user-token";
      if (tool.name === "search" || tool.name === "memory_search") {
        args.query = "q";
      }
      if (tool.name === "memory_recall") args.question = "q";
      if (tool.name === "fetch") args.id = "viralbrain";
      if (tool.name === "get_record_by_id") args.record_id = REAL_UUID;
      if (tool.name === "custody_resolve_alias") {
        args.alias = "project:x/y/current";
      }
      if (
        tool.name.startsWith("custody_") &&
        tool.name !== "custody_resolve_alias"
      ) {
        args.version_id = "f509c795-367c-46d4-af79-536ae7f8d402";
      }
      if (tool.name === "memory_get_by_session") args.session_number = 1;
      if (tool.name === "memory_write") {
        args.session_number = 1;
        args.objective = "o";
      }

      const res = await handler.handleToolCall({
        name: tool.name,
        arguments: args,
      });
      const text = res.content.map((c: any) => c.text).join("");
      assert(
        !text.includes("Unknown tool"),
        `${tool.name} fell through the dispatcher: ${text.slice(0, 200)}`,
      );
    }
  } finally {
    stub.restore();
    Deno.env.delete(CUSTODY_KEY_ENV);
  }
});

Deno.test("an unregistered tool name still reports Unknown tool", async () => {
  const res = await new MemoryToolHandler().handleToolCall({
    name: "definitely_not_a_tool",
    arguments: {},
  });
  assertEquals(res.isError, true);
  assertStringIncludes(res.content[0].text, "Unknown tool");
});

// ─── get_record_by_id ──────────────────────────────────────────────────

Deno.test("get_record_by_id returns the FULL body, not an excerpt", async () => {
  const stub = stubFetch([["/rest/v1/ns_records", [RECORD_ROW]]]);
  try {
    const res = await new MemoryToolHandler().handleToolCall({
      name: "get_record_by_id",
      arguments: {
        record_id: REAL_UUID,
        client_id: "neuralsynch",
        __access_token: "test-user-token",
      },
    });
    const parsed = JSON.parse(res.content[0].text);
    assertEquals(parsed.found, true);
    assertEquals(parsed.id, REAL_UUID);
    assertEquals(
      parsed.body.length,
      RECORD_ROW.body.length,
      "body was truncated",
    );
    assertEquals(parsed.truncated, false);
  } finally {
    stub.restore();
  }
});

Deno.test("get_record_by_id fails CLOSED when the record does not exist", async () => {
  const stub = stubFetch([["/rest/v1/ns_records", []]]);
  try {
    const res = await new MemoryToolHandler().handleToolCall({
      name: "get_record_by_id",
      arguments: {
        record_id: REAL_UUID,
        client_id: "neuralsynch",
        __access_token: "test-user-token",
      },
    });
    const parsed = JSON.parse(res.content[0].text);
    assertEquals(
      res.isError,
      true,
      "a missing record must be an error, not a quiet success",
    );
    assertEquals(parsed.found, false);
    assertEquals(parsed.error, "RECORD_NOT_FOUND");
  } finally {
    stub.restore();
  }
});

Deno.test("get_record_by_id rejects a non-UUID instead of guessing", async () => {
  const res = await new MemoryToolHandler().handleToolCall({
    name: "get_record_by_id",
    arguments: { record_id: "viralbrain" },
  });
  assertEquals(res.isError, true);
  assertStringIncludes(res.content[0].text, "must be an ns_records UUID");
});

// ─── the fetch correction (the original defect) ────────────────────────

Deno.test("REGRESSION: fetch(UUID) returns the record, not an empty client packet", async () => {
  // Before the fix this hit retrieve-context-packet with the UUID as a
  // client_id and returned a confident empty packet with no error.
  const stub = stubFetch([
    ["/rest/v1/ns_records", [RECORD_ROW]],
    ["/functions/v1/retrieve-context-packet", {
      context_prompt:
        "No locked decisions found. No active records in ns_records yet.",
      session_number: 0,
      locked_decisions_count: 0,
      memory_records_count: 0,
    }],
  ]);
  try {
    const res = await new MemoryToolHandler().handleToolCall({
      name: "fetch",
      arguments: {
        id: REAL_UUID,
        client_id: "neuralsynch",
        __access_token: "test-user-token",
      },
    });
    const text = res.content[0].text;
    assert(
      !text.includes("No locked decisions found"),
      "fetch still fell through to the empty client packet",
    );
    const parsed = JSON.parse(text);
    assertEquals(parsed.found, true);
    assertEquals(parsed.id, REAL_UUID);
    assertEquals(parsed.body.length, RECORD_ROW.body.length);

    assert(
      !stub.urls.some((u) => u.includes("retrieve-context-packet")),
      "fetch(UUID) must not call the client-packet endpoint at all",
    );
  } finally {
    stub.restore();
  }
});

Deno.test("BACKWARD COMPAT: fetch(client_id) still returns the memory packet", async () => {
  const stub = stubFetch([
    ["/functions/v1/retrieve-context-packet", {
      context_prompt: "packet body here",
      session_number: 42,
      locked_decisions_count: 3,
      memory_records_count: 7,
      anti_amnesia_status: "ok",
    }],
  ]);
  try {
    const res = await new MemoryToolHandler().handleToolCall({
      name: "fetch",
      arguments: { id: "viralbrain", __access_token: "test-user-token" },
    });
    const parsed = JSON.parse(res.content[0].text);
    assertEquals(parsed.id, "viralbrain");
    assertEquals(parsed.text, "packet body here");
    assertEquals(parsed.metadata.session_number, 42);
    assert(
      stub.urls.some((u) => u.includes("retrieve-context-packet")),
      "non-UUID fetch must still use the client-packet path",
    );
  } finally {
    stub.restore();
  }
});

Deno.test("fetch(UUID) for a missing record fails closed rather than returning a packet", async () => {
  const stub = stubFetch([
    ["/rest/v1/ns_records", []],
    ["/functions/v1/retrieve-context-packet", {
      context_prompt: "should never be reached",
    }],
  ]);
  try {
    const res = await new MemoryToolHandler().handleToolCall({
      name: "fetch",
      arguments: {
        id: REAL_UUID,
        client_id: "neuralsynch",
        __access_token: "test-user-token",
      },
    });
    assertEquals(res.isError, true);
    assertStringIncludes(res.content[0].text, "RECORD_NOT_FOUND");
  } finally {
    stub.restore();
  }
});
