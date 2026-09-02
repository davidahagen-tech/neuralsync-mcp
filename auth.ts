// OAuth 2.1 resource-server authentication for the NeuralSynch MCP surface.
//
// The OAuth access token establishes an Auth user. Tenant authority comes
// only from public.ns_tenant_memberships rows visible to that user through
// RLS. A caller-supplied client_id remains accepted for wire compatibility,
// but it is never authority and is rejected when it is not a bound tenant.

export interface MCPPrincipal {
  userId: string;
  email?: string;
  accessToken: string;
  tenantRoles: ReadonlyMap<string, string>;
}

export class MCPAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message);
    this.name = "MCPAuthError";
  }
}

export const DEFAULT_SUPABASE_URL = "https://udafklielwqdppnagtwc.supabase.co";

// Public key: intentionally not a credential. It identifies the Supabase
// project while the user bearer token establishes the authenticated session.
export const DEFAULT_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVkYWZrbGllbHdxZHBwbmFndHdjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQzNTgxNzgsImV4cCI6MjA4OTkzNDE3OH0.0ueCBWNfdZGOHsLlJW9P3tUQ7QgD7tGmM6CQ1ZbOaAQ";

function bearerToken(request: Request): string {
  const value = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  if (!match?.[1]) {
    throw new MCPAuthError(401, "A valid OAuth bearer token is required.");
  }
  return match[1];
}

export async function authenticateMCPRequest(
  request: Request,
  fetcher: typeof fetch = fetch,
): Promise<MCPPrincipal> {
  const accessToken = bearerToken(request);
  const baseUrl = Deno.env.get("SUPABASE_URL") ?? DEFAULT_SUPABASE_URL;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ??
    DEFAULT_SUPABASE_ANON_KEY;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    apikey: anonKey,
  };

  const userResponse = await fetcher(`${baseUrl}/auth/v1/user`, { headers });
  if (!userResponse.ok) {
    throw new MCPAuthError(
      401,
      "The OAuth bearer token is invalid or expired.",
    );
  }
  const user = await userResponse.json();
  if (!user?.id || typeof user.id !== "string") {
    throw new MCPAuthError(
      401,
      "The OAuth token did not resolve to an Auth user.",
    );
  }

  // This request deliberately uses the user token, not service_role. The
  // membership table's RLS policy is the authorization boundary.
  const membershipUrl = new URL(`${baseUrl}/rest/v1/ns_tenant_memberships`);
  membershipUrl.searchParams.set("select", "client_id,role");
  membershipUrl.searchParams.set("auth_user_id", `eq.${user.id}`);
  membershipUrl.searchParams.set("active", "is.true");
  const membershipResponse = await fetcher(membershipUrl, { headers });
  if (!membershipResponse.ok) {
    throw new MCPAuthError(403, "Tenant membership could not be established.");
  }
  const rows = await membershipResponse.json();
  const tenantRoles = new Map<string, string>();
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (typeof row?.client_id === "string" && typeof row?.role === "string") {
        tenantRoles.set(row.client_id, row.role);
      }
    }
  }
  if (tenantRoles.size === 0) {
    throw new MCPAuthError(
      403,
      "The authenticated user has no active NeuralSynch tenant membership.",
    );
  }

  return {
    userId: user.id,
    email: typeof user.email === "string" ? user.email : undefined,
    accessToken,
    tenantRoles,
  };
}

export function defaultClientIdForTool(toolName: string): string {
  return toolName.startsWith("custody_") ? "neuralsynch" : "viralbrain";
}

export function bindToolArguments(
  toolName: string,
  rawArgs: unknown,
  principal: MCPPrincipal,
): Record<string, unknown> {
  const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
    ? { ...(rawArgs as Record<string, unknown>) }
    : {};
  const fetchPacketId = toolName === "fetch" &&
      typeof args.id === "string" &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        .test(args.id.trim())
    ? args.id
    : undefined;
  const requested = fetchPacketId ??
    (typeof args.client_id === "string" && args.client_id.length > 0
      ? args.client_id
      : defaultClientIdForTool(toolName));

  if (!principal.tenantRoles.has(requested)) {
    throw new MCPAuthError(
      403,
      `The authenticated identity is not authorized for tenant ${requested}.`,
    );
  }

  args.client_id = requested;
  if (fetchPacketId !== undefined) args.id = requested;
  // Internal-only transport value. It is not part of any advertised schema
  // and is consumed only when calling JWT-protected Edge Functions.
  Object.defineProperty(args, "__access_token", {
    value: principal.accessToken,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return args;
}
