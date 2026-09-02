import { assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import {
  authenticateMCPRequest,
  bindToolArguments,
  MCPAuthError,
  type MCPPrincipal,
} from "../auth.ts";

const principal: MCPPrincipal = {
  userId: "00000000-0000-4000-8000-000000000001",
  accessToken: "test-user-token",
  tenantRoles: new Map([
    ["viralbrain", "owner"],
    ["neuralsynch", "reader"],
  ]),
};

Deno.test("legacy client_id is accepted only when bound to the OAuth identity", () => {
  const args = bindToolArguments(
    "memory_search",
    { client_id: "viralbrain", query: "x" },
    principal,
  );
  assertEquals(args.client_id, "viralbrain");
  assertEquals(args.query, "x");
  assertEquals(Object.keys(args).includes("__access_token"), false);
});

Deno.test("legacy defaults remain tool-specific but do not create authority", () => {
  assertEquals(
    bindToolArguments("memory_read", {}, principal).client_id,
    "viralbrain",
  );
  assertEquals(
    bindToolArguments("custody_resolve_alias", {}, principal).client_id,
    "neuralsynch",
  );
});

Deno.test("reference-addressed custody tools defer tenant scope to the custody object", () => {
  const alphaPrincipal: MCPPrincipal = {
    userId: principal.userId,
    accessToken: principal.accessToken,
    tenantRoles: new Map([["p0-alpha", "owner"]]),
  };
  for (
    const toolName of [
      "custody_get_metadata",
      "custody_retrieve",
      "custody_verify",
      "custody_finalize_upload",
      "custody_add_dependency",
      "custody_dependency_closure",
      "custody_export_session",
      "custody_scan_archive",
      "custody_report_missing",
    ]
  ) {
    const args = bindToolArguments(
      toolName,
      { version_id: "30000000-0000-4000-8000-000000000003" },
      alphaPrincipal,
    );
    assertEquals(
      Object.hasOwn(args, "client_id"),
      false,
      `${toolName} must not receive an invented tenant`,
    );
    assertEquals(Object.keys(args).includes("__access_token"), false);
    assertEquals((args as any).__access_token, principal.accessToken);
  }
});

Deno.test("an explicit tenant on a reference-addressed custody call is still validated", async () => {
  await assertRejects(
    async () =>
      bindToolArguments(
        "custody_get_metadata",
        {
          version_id: "30000000-0000-4000-8000-000000000003",
          client_id: "other-tenant",
        },
        principal,
      ),
    MCPAuthError,
    "not authorized",
  );
});

Deno.test("cross-tenant client_id mismatch fails closed", async () => {
  await assertRejects(
    async () =>
      bindToolArguments(
        "memory_read",
        { client_id: "other-tenant" },
        principal,
      ),
    MCPAuthError,
    "not authorized",
  );
});

Deno.test("OAuth subject is resolved before RLS-visible membership", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/auth/v1/user")) {
      return Promise.resolve(
        Response.json({ id: principal.userId, email: "owner@example.test" }),
      );
    }
    return Promise.resolve(
      Response.json([{ client_id: "viralbrain", role: "owner" }]),
    );
  };
  const out = await authenticateMCPRequest(
    new Request("https://mcp.example.test/mcp", {
      headers: { Authorization: "Bearer test-user-token" },
    }),
    fetcher,
  );
  assertEquals(out.userId, principal.userId);
  assertEquals(out.tenantRoles.get("viralbrain"), "owner");
  assertEquals(calls.length, 2);
  assertEquals(calls[1].includes("auth_user_id=eq."), true);
});

Deno.test("missing bearer token fails before any network call", async () => {
  let called = false;
  const fetcher: typeof fetch = () => {
    called = true;
    return Promise.resolve(Response.json({}));
  };
  await assertRejects(
    () =>
      authenticateMCPRequest(
        new Request("https://mcp.example.test/mcp"),
        fetcher,
      ),
    MCPAuthError,
    "bearer token",
  );
  assertEquals(called, false);
});
