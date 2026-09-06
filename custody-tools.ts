// Custody tool handlers for MCP protocol — v1.0 (NS artifact custody, bounded)
//
// Exposes the ALREADY-DEPLOYED NeuralSynch artifact-custody service through the
// existing NeuralSynch MCP. This file adds NO custody schema, bucket, storage
// implementation or policy — all of that is already live in Supabase project
// udafklielwqdppnagtwc (tables ns_artifact_*, private bucket ns-artifacts,
// Edge Function neuralsync-custody). This is a transport surface only.
//
// WHY THIS EXISTS
//   Before this file, Cowork and ChatGPT could see 12 memory tools and no way
//   to retrieve a real file by its bytes. Custody was deployed and proven, but
//   unreachable from the agents that needed it.
//
// SECURITY MODEL
//   The scoped custody key lives ONLY in this server's environment. ChatGPT and
//   Cowork never see it, never send it, and never hold it — this server is the
//   trusted server-side caller. The key is never echoed in a tool result, never
//   included in an error message, and never logged. See redact() below.
//
//   Env var (Deno Deploy) — the ONLY name read, verified against the live app
//   settings page on 2026-08-05:
//     NEURALSYNC_CHATGPT_CUSTODY_KEY
//
//   There is deliberately NO fallback name. A second accepted name is a second
//   place a stale or wrong key can hide, and a silent one: the server would
//   authenticate with whichever it found first. One name, or a loud failure.
//
// FAIL-CLOSED
//   Typed custody errors (ALIAS_NOT_FOUND, ARTIFACT_BYTES_MISSING,
//   ARTIFACT_HASH_MISMATCH, UNAUTHORIZED, FORBIDDEN) are surfaced verbatim and
//   never collapsed into a generic failure or a plausible-looking empty result.

export const CUSTODY_ENDPOINT =
  "https://udafklielwqdppnagtwc.supabase.co/functions/v1/neuralsync-custody";

const NS_DEFAULT_CLIENT = "neuralsynch";
const NS_DEFAULT_PROJECT = "neuralsynch-custody";

// ─── S252 governed-write provenance ───────────────────────────────────────
// This exposure exists so Claude App/Cowork can perform GOVERNED custody
// writes, so a write from this surface is stamped 'claude-app' by default. The
// other four values are preserved for the Master-AI surfaces that share this
// custody backend. created_through is an HONEST provenance LABEL on the version
// row; it does NOT set the authenticated principal. The backend derives the
// principal (created_by) from the server-held custody key via
// ns_artifact_agent_keys, and authorises the write against
// ns_artifact_memberships(client_id, project, principal). This shared MCP
// service credential cannot cryptographically distinguish the calling agent, so
// we never forge a per-agent principal — we record the surface that made the
// call and leave created_by to the backend. Authorisation stays fully
// server-side and fail-closed.
const NS_DEFAULT_PROVENANCE = "claude-app";
const NS_ALLOWED_PROVENANCE = new Set([
  "claude-app",
  "claude-code",
  "chatgpt",
  "studio",
  "website",
]);

// The custody backend's dependency edge vocabulary is a FIXED set (enforced by
// a CHECK constraint on ns_artifact_dependencies.dep_type). We validate at the
// MCP layer so an invalid type fails before any network call, with a message
// that names the permitted set — never inventing a type.
const NS_DEP_TYPES = new Set([
  "CONTAINS",
  "DEPENDS_ON",
  "GENERATED_FROM",
  "SUPERSEDES",
  "DOCUMENTS",
  "VERIFIES",
  "PACKAGES",
  "REFERENCES",
]);

// Single-shot base64 ceiling. The custody backend stores a whole artifact in
// one base64 body; there is deliberately NO multipart path on this surface (the
// D-5 multipart design is not implemented here). A payload above this limit
// fails CLOSED with a clear message rather than a false "stored" result or a
// false multipart claim.
const NS_MAX_BASE64_CHARS = 8 * 1024 * 1024; // 8 MB of base64 text
const NS_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export interface CustodyToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** The one and only environment variable this server reads for custody auth. */
export const CUSTODY_KEY_ENV = "NEURALSYNC_CHATGPT_CUSTODY_KEY";

/**
 * Resolve the scoped custody key from the server environment.
 * Reads exactly one variable — no fallback, no alias, no legacy name.
 * Returns undefined (never throws) when it is unset, so tools/list still works
 * on a server with no key bound; only tools/call fails, and it fails loudly.
 */
export function resolveCustodyKey(): string | undefined {
  return Deno.env.get(CUSTODY_KEY_ENV) || undefined;
}

/**
 * Strip anything credential-shaped from a string before it can reach a tool
 * result, an error message, or a log line. Belt and braces: the literal
 * configured key is removed first, then known credential shapes by pattern.
 */
export function redact(s: string): string {
  if (!s) return s;
  const key = resolveCustodyKey() ?? "";
  let out = s;
  if (key) out = out.split(key).join("[REDACTED]");
  return out
    .replace(/nsck_[0-9a-fA-F]{8,}/g, "[REDACTED]")
    .replace(/eyJ[A-Za-z0-9_\-.]{20,}/g, "[REDACTED]")
    .replace(/sb_secret_[A-Za-z0-9_\-]+/g, "[REDACTED]")
    .replace(/sb_publishable_[A-Za-z0-9_\-]+/g, "[REDACTED]")
    .replace(/(x-custody-key)["'\s:=]+[^"'\s,}]+/gi, "$1: [REDACTED]");
}

/**
 * Call the deployed custody Edge Function server-side.
 * The key is attached here and nowhere else. It is never returned to the caller.
 */
export async function custodyCall(
  op: string,
  args: Record<string, unknown>,
  accessToken?: string,
): Promise<any> {
  const key = accessToken ? undefined : resolveCustodyKey();
  if (!accessToken && !key) {
    throw new Error(
      `CUSTODY_KEY_NOT_CONFIGURED: no custody key is bound to this MCP server. ` +
        `Set the environment variable ${CUSTODY_KEY_ENV} on this deployment. ` +
        `No other variable name is read. Custody tools are unavailable until it is set.`,
    );
  }

  const endpoint = Deno.env.get("NEURALSYNC_CUSTODY_ENDPOINT") ??
    CUSTODY_ENDPOINT;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (accessToken) {
    const publishableKey = Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
    if (!publishableKey) {
      throw new Error(
        "CUSTODY_AUTH_NOT_CONFIGURED: SUPABASE_PUBLISHABLE_KEY is required for OAuth custody calls.",
      );
    }
    headers.Authorization = `Bearer ${accessToken}`;
    headers.apikey = publishableKey;
  } else if (key) {
    headers["x-custody-key"] = key;
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ op, args }),
  });

  let data: any = {};
  try {
    data = await res.json();
  } catch {
    throw new Error(
      `CUSTODY_TRANSPORT_ERROR: custody service returned a non-JSON response (HTTP ${res.status})`,
    );
  }

  if (!data?.ok) {
    const code = data?.error?.code ?? "VERIFICATION_FAILURE";
    const detail = redact(String(data?.error?.detail ?? `HTTP ${res.status}`));
    throw new Error(`${code}: ${detail}`);
  }
  return data.result;
}

export class CustodyToolHandler {
  private call(
    op: string,
    payload: Record<string, unknown>,
    sourceArgs: any,
  ): Promise<any> {
    return custodyCall(op, payload, sourceArgs?.__access_token);
  }

  // ─── custody_resolve_alias ───────────────────────────────────────────
  async handleResolveAlias(args: any): Promise<CustodyToolResult> {
    if (!args?.alias || typeof args.alias !== "string") {
      throw new Error("alias is required for custody_resolve_alias");
    }
    const r = await this.call("resolve_alias", {
      client_id: args.client_id || NS_DEFAULT_CLIENT,
      project: args.project || NS_DEFAULT_PROJECT,
      alias: args.alias,
    }, args);
    return {
      content: [{
        type: "text",
        text: JSON.stringify(
          {
            alias: r.alias,
            version_id: r.version_id,
            artifact_id: r.artifact_id,
            sha256: r.sha256,
            byte_length: r.byte_length,
            custody_state: r.custody_state,
            safe_filename: r.safe_filename,
            note:
              "METADATA ONLY. Call custody_retrieve with this version_id to get the actual file bytes.",
          },
          null,
          2,
        ),
      }],
    };
  }

  // ─── custody_get_metadata ────────────────────────────────────────────
  async handleGetMetadata(args: any): Promise<CustodyToolResult> {
    if (!args?.version_id || typeof args.version_id !== "string") {
      throw new Error("version_id is required for custody_get_metadata");
    }
    const r = await this.call(
      "get_metadata",
      { version_id: args.version_id },
      args,
    );
    return {
      content: [{
        type: "text",
        text: JSON.stringify(
          {
            version_id: r.id ?? r.version_id,
            artifact_id: r.artifact_id,
            client_id: r.client_id,
            project: r.project,
            sha256: r.sha256,
            byte_length: r.byte_length,
            media_type: r.media_type,
            original_filename: r.original_filename,
            safe_filename: r.safe_filename,
            logical_project_path: r.logical_project_path,
            classification: r.classification,
            custody_state: r.custody_state,
            created_by: r.created_by,
            created_through: r.created_through,
            created_at: r.created_at,
            verified_at: r.verified_at,
            note: "METADATA ONLY — no bytes returned.",
          },
          null,
          2,
        ),
      }],
    };
  }

  // ─── custody_retrieve ────────────────────────────────────────────────
  async handleRetrieve(args: any): Promise<CustodyToolResult> {
    if (!args?.version_id || typeof args.version_id !== "string") {
      throw new Error("version_id is required for custody_retrieve");
    }
    const r = await this.call(
      "retrieve",
      { version_id: args.version_id },
      args,
    );
    return {
      content: [{
        type: "text",
        text: JSON.stringify(
          {
            version_id: r.version_id,
            safe_filename: r.safe_filename,
            sha256: r.sha256,
            byte_length: r.byte_length,
            media_type: r.media_type,
            custody_state: r.custody_state,
            encoding: "base64",
            content_base64: r.content_base64,
            instruction:
              `Decode content_base64, write it to disk, recompute SHA-256 and confirm it equals ${r.sha256} before treating this file as retrieved. The custody service already verified it server-side; verifying again is the point of custody.`,
          },
          null,
          2,
        ),
      }],
    };
  }

  // ─── custody_verify ──────────────────────────────────────────────────
  async handleVerify(args: any): Promise<CustodyToolResult> {
    if (!args?.version_id || typeof args.version_id !== "string") {
      throw new Error("version_id is required for custody_verify");
    }
    const r = await this.call("verify", { version_id: args.version_id }, args);
    return {
      content: [{
        type: "text",
        text: JSON.stringify(
          {
            version_id: r.version_id,
            verified: r.verified === true,
            sha256: r.sha256,
            byte_length: r.byte_length,
            custody_state: r.custody_state,
            code: r.code,
            note: r.verified === true
              ? "Bytes were re-read and re-hashed server-side and match the recorded SHA-256."
              : "VERIFICATION FAILED — do not substitute a path, URL or legacy Vault record for this artifact.",
          },
          null,
          2,
        ),
      }],
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // S252 — GOVERNED WRITES + EXTENDED READS (custody wire ops store,
  // set_alias, list_versions, add_dependency, dependency_closure,
  // export_session, scan_archive, report_missing). Each delegates to the
  // already-deployed backend op of the same name; none re-implements policy.
  // ═══════════════════════════════════════════════════════════════════════

  // ─── custody_store (write) ───────────────────────────────────────────
  async handleStore(args: any): Promise<CustodyToolResult> {
    for (
      const f of ["project", "artifact_name", "filename", "content_base64"]
    ) {
      if (!args?.[f] || typeof args[f] !== "string") {
        throw new Error(`${f} is required for custody_store`);
      }
    }
    const created_through = args.created_through ?? NS_DEFAULT_PROVENANCE;
    if (!NS_ALLOWED_PROVENANCE.has(created_through)) {
      throw new Error(
        `created_through must be one of ${
          [...NS_ALLOWED_PROVENANCE].join(", ")
        } — ` +
          `refusing to stamp an unrecognised provenance on a custody version`,
      );
    }
    if (args.content_base64.length > NS_MAX_BASE64_CHARS) {
      throw new Error(
        `PAYLOAD_TOO_LARGE: content_base64 is ${args.content_base64.length} characters, ` +
          `over the ${NS_MAX_BASE64_CHARS}-character (8 MB) single-shot limit. This surface ` +
          `stores an artifact in one base64 body; multipart is NOT implemented here. ` +
          `The store was NOT attempted — no bytes were sent.`,
      );
    }
    const r = await this.call("store", {
      client_id: args.client_id || NS_DEFAULT_CLIENT,
      project: args.project,
      artifact_name: args.artifact_name,
      filename: args.filename,
      content_base64: args.content_base64,
      created_through,
    }, args);
    return {
      content: [{
        type: "text",
        text: JSON.stringify(
          {
            artifact_id: r.artifact_id,
            version_id: r.version_id,
            sha256: r.sha256,
            byte_length: r.byte_length,
            media_type: r.media_type,
            custody_state: r.custody_state,
            created_through,
            verified_at: r.verified_at,
            note:
              "IMMUTABLE version created. The backend wrote the bytes, read them back and re-hashed them server-side; custody_state CUSTODIED means the read-back SHA-256 and byte length matched what was sent. Storing the same artifact_name again creates a NEW version — it NEVER overwrites existing bytes. Recompute the SHA-256 from your source bytes and confirm it equals the returned sha256 before treating this as preserved.",
          },
          null,
          2,
        ),
      }],
    };
  }

  // ─── custody_begin_upload (write, metadata only) ─────────────────────
  async handleBeginUpload(args: any): Promise<CustodyToolResult> {
    for (
      const f of [
        "project",
        "artifact_name",
        "filename",
        "expected_sha256",
        "media_type",
      ]
    ) {
      if (!args?.[f] || typeof args[f] !== "string") {
        throw new Error(`${f} is required for custody_begin_upload`);
      }
    }
    if (!/^[0-9a-f]{64}$/.test(args.expected_sha256)) {
      throw new Error(
        "expected_sha256 must be 64 lowercase hexadecimal characters for custody_begin_upload",
      );
    }
    if (
      !Number.isSafeInteger(args.expected_byte_length) ||
      args.expected_byte_length <= 0 ||
      args.expected_byte_length > NS_MAX_UPLOAD_BYTES
    ) {
      throw new Error(
        `expected_byte_length must be an integer from 1 to ${NS_MAX_UPLOAD_BYTES} for custody_begin_upload`,
      );
    }
    if (
      args.filename === "." || args.filename === ".." ||
      /[\\/\u0000\r\n]/.test(args.filename)
    ) {
      throw new Error(
        "filename must be a single traversal-free file name for custody_begin_upload",
      );
    }
    if (
      !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/
        .test(args.media_type)
    ) {
      throw new Error("media_type is invalid for custody_begin_upload");
    }
    if (
      args.logical_project_path &&
      (typeof args.logical_project_path !== "string" ||
        args.logical_project_path.startsWith("/") ||
        /^[A-Za-z]:/.test(args.logical_project_path) ||
        args.logical_project_path.replace(/\\/g, "/").split("/").includes(".."))
    ) {
      throw new Error(
        "logical_project_path must be relative and traversal-free for custody_begin_upload",
      );
    }
    if (
      args.classification !== undefined &&
      (typeof args.classification !== "string" ||
        args.classification.length === 0 || args.classification.length > 100 ||
        /[\u0000\r\n]/.test(args.classification))
    ) {
      throw new Error(
        "classification must be a non-empty string of at most 100 characters for custody_begin_upload",
      );
    }
    const created_through = args.created_through ?? NS_DEFAULT_PROVENANCE;
    if (!NS_ALLOWED_PROVENANCE.has(created_through)) {
      throw new Error(
        `created_through must be one of ${
          [...NS_ALLOWED_PROVENANCE].join(", ")
        }`,
      );
    }
    const r = await this.call("begin_upload", {
      client_id: args.client_id || NS_DEFAULT_CLIENT,
      project: args.project,
      artifact_name: args.artifact_name,
      filename: args.filename,
      expected_sha256: args.expected_sha256,
      expected_byte_length: args.expected_byte_length,
      media_type: args.media_type,
      created_through,
      ...(args.logical_project_path
        ? { logical_project_path: args.logical_project_path }
        : {}),
      ...(args.classification ? { classification: args.classification } : {}),
    }, args);
    return {
      content: [{
        type: "text",
        text: JSON.stringify(
          {
            upload_id: r.upload_id,
            signed_upload_url: r.signed_upload_url,
            method: r.method,
            headers: r.headers,
            application_expires_at: r.application_expires_at,
            expected_sha256: r.expected_sha256,
            expected_byte_length: r.expected_byte_length,
            instruction:
              "Immediately PUT the local file bytes to signed_upload_url using exactly the returned headers, without base64 encoding. The application finalization window is 15 minutes. Never log, persist, reuse, commit or report the signed URL.",
          },
          null,
          2,
        ),
      }],
    };
  }

  // ─── custody_finalize_upload (write, exactly once) ────────────────────
  async handleFinalizeUpload(args: any): Promise<CustodyToolResult> {
    if (!args?.upload_id || typeof args.upload_id !== "string") {
      throw new Error("upload_id is required for custody_finalize_upload");
    }
    const r = await this.call(
      "finalize_upload",
      { upload_id: args.upload_id },
      args,
    );
    return {
      content: [{
        type: "text",
        text: JSON.stringify(
          {
            artifact_id: r.artifact_id,
            version_id: r.version_id,
            sha256: r.sha256,
            byte_length: r.byte_length,
            filename: r.filename,
            media_type: r.media_type,
            logical_project_path: r.logical_project_path,
            classification: r.classification,
            custody_state: r.custody_state,
            created_through: r.created_through,
            verified_at: r.verified_at,
            temporary_object_removed: r.temporary_object_removed,
            signed_retrieval_url: r.signed_retrieval_url,
            retrieval_expires_at: r.retrieval_expires_at,
            note:
              "The backend reauthorized the pending scope, read and hashed the uploaded bytes, compared SHA-256 and length, created a new immutable permanent version, read it back and verified it again. Only custody_state CUSTODIED is success. Download selected bytes directly from signed_retrieval_url before retrieval_expires_at; never log, persist, commit or report that URL.",
          },
          null,
          2,
        ),
      }],
    };
  }

  // ─── custody_set_alias (write) ───────────────────────────────────────
  async handleSetAlias(args: any): Promise<CustodyToolResult> {
    for (const f of ["project", "alias", "version_id"]) {
      if (!args?.[f] || typeof args[f] !== "string") {
        throw new Error(`${f} is required for custody_set_alias`);
      }
    }
    const r = await this.call("set_alias", {
      client_id: args.client_id || NS_DEFAULT_CLIENT,
      project: args.project,
      alias: args.alias,
      version_id: args.version_id,
    }, args);
    return {
      content: [{
        type: "text",
        text: JSON.stringify(
          {
            alias: r.alias,
            version_id: r.version_id,
            ok: r.ok === true,
            note:
              "Alias now points to this immutable version. An alias may only target a version that exists in the SAME client_id/project — otherwise it fails ALIAS_TARGET_MISSING. Re-pointing an existing alias records an auditable event and updates the pointer only; it never mutates or deletes any stored bytes.",
          },
          null,
          2,
        ),
      }],
    };
  }

  // ─── custody_list_versions (read) ────────────────────────────────────
  async handleListVersions(args: any): Promise<CustodyToolResult> {
    for (const f of ["project", "artifact_name"]) {
      if (!args?.[f] || typeof args[f] !== "string") {
        throw new Error(`${f} is required for custody_list_versions`);
      }
    }
    const r = await this.call("list_versions", {
      client_id: args.client_id || NS_DEFAULT_CLIENT,
      project: args.project,
      artifact_name: args.artifact_name,
    }, args);
    return {
      content: [{
        type: "text",
        text: JSON.stringify(
          {
            artifact_name: r.artifact_name,
            versions: r.versions,
            note:
              "Immutable version history for this artifact_name within the project, oldest first. Each version is a distinct set of bytes; nothing here is ever overwritten.",
          },
          null,
          2,
        ),
      }],
    };
  }

  // ─── custody_add_dependency (write) ──────────────────────────────────
  async handleAddDependency(args: any): Promise<CustodyToolResult> {
    for (const f of ["from_version_id", "to_version_id", "dep_type"]) {
      if (!args?.[f] || typeof args[f] !== "string") {
        throw new Error(`${f} is required for custody_add_dependency`);
      }
    }
    if (!NS_DEP_TYPES.has(args.dep_type)) {
      throw new Error(
        `dep_type must be one of ${[...NS_DEP_TYPES].join(", ")} — ` +
          `this vocabulary is fixed by the backend; do not invent a type`,
      );
    }
    const r = await this.call("add_dependency", {
      from_version_id: args.from_version_id,
      to_version_id: args.to_version_id,
      dep_type: args.dep_type,
    }, args);
    return {
      content: [{
        type: "text",
        text: JSON.stringify(
          {
            ok: r.ok === true,
            from_version_id: args.from_version_id,
            to_version_id: args.to_version_id,
            dep_type: args.dep_type,
            note:
              "Directed dependency edge recorded (from → to). The target version must already exist or the call fails DEPENDENCY_MISSING. Edges are additive and auditable; re-adding an identical edge is a no-op.",
          },
          null,
          2,
        ),
      }],
    };
  }

  // ─── custody_dependency_closure (read) ───────────────────────────────
  async handleDependencyClosure(args: any): Promise<CustodyToolResult> {
    if (!args?.root_version_id || typeof args.root_version_id !== "string") {
      throw new Error(
        "root_version_id is required for custody_dependency_closure",
      );
    }
    const r = await this.call("dependency_closure", {
      root_version_id: args.root_version_id,
    }, args);
    return {
      content: [{
        type: "text",
        text: JSON.stringify(
          {
            root: r.root,
            members: r.members,
            missing_version_ids: r.missing_version_ids,
            note:
              "Complete transitive dependency graph reachable from the root version. missing_version_ids lists referenced versions whose rows are absent — anything listed there must be recovered before the set is considered complete.",
          },
          null,
          2,
        ),
      }],
    };
  }

  // ─── custody_export_session (write — creates an export record) ───────
  async handleExportSession(args: any): Promise<CustodyToolResult> {
    if (!args?.root_version_id || typeof args.root_version_id !== "string") {
      throw new Error("root_version_id is required for custody_export_session");
    }
    const r = await this.call("export_session", {
      root_version_id: args.root_version_id,
    }, args);
    return {
      content: [{
        type: "text",
        text: JSON.stringify(
          {
            export_id: r.export_id,
            sha256: r.sha256,
            byte_length: r.byte_length,
            complete: r.complete === true,
            missing: r.missing,
            encoding: "base64",
            content_base64: r.content_base64,
            instruction:
              "This is a self-contained ZIP of the dependency closure plus MANIFEST.json and SHA256SUMS.txt. Decode content_base64, extract it, and re-hash every member against MANIFEST.json. complete=false or a non-empty missing[] means the closure could not be fully reconstructed — treat it as incomplete, not preserved.",
          },
          null,
          2,
        ),
      }],
    };
  }

  // ─── custody_scan_archive (write — records archive entries) ──────────
  async handleScanArchive(args: any): Promise<CustodyToolResult> {
    if (!args?.version_id || typeof args.version_id !== "string") {
      throw new Error("version_id is required for custody_scan_archive");
    }
    const r = await this.call(
      "scan_archive",
      { version_id: args.version_id },
      args,
    );
    return {
      content: [{
        type: "text",
        text: JSON.stringify(
          {
            archive_version_id: r.archive_version_id,
            entry_count: r.entry_count,
            unsafe_entries: r.unsafe_entries,
            duplicate_entries: r.duplicate_entries,
            encrypted_present: r.encrypted_present,
            unsupported_present: r.unsupported_present,
            nested_archives: r.nested_archives,
            entries: r.entries,
            note:
              "ZIP central-directory inventory only. It identifies nested archives, unsafe/absolute/traversal paths, duplicates and encrypted entries, but does NOT recurse into nested archives and does NOT compute per-entry hashes (entry_sha256 is null). Only store and deflate compression are treated as supported. At most 200 entries are returned inline.",
          },
          null,
          2,
        ),
      }],
    };
  }

  // ─── custody_report_missing (read) ───────────────────────────────────
  async handleReportMissing(args: any): Promise<CustodyToolResult> {
    if (!args?.version_id || typeof args.version_id !== "string") {
      throw new Error("version_id is required for custody_report_missing");
    }
    const r = await this.call(
      "report_missing",
      { version_id: args.version_id },
      args,
    );
    return {
      content: [{
        type: "text",
        text: JSON.stringify(
          {
            version_id: r.version_id,
            status: r.status,
            object_key: r.object_key,
            note:
              "status is the live custody state: CUSTODIED means the bytes are present and their SHA-256 still matches; ARTIFACT_NOT_FOUND, ARTIFACT_BYTES_MISSING or ARTIFACT_HASH_MISMATCH each name a specific fail-closed condition. Use this to detect absent or corrupted dependencies without transferring any payload.",
          },
          null,
          2,
        ),
      }],
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// MCP DISCOVERY SCHEMAS — custody surface
// ═══════════════════════════════════════════════════════════════════════
// All four are read-only (readOnlyHint: true) so ChatGPT does not raise a
// confirmation modal. Nothing here can write, store, delete or supersede an
// artifact — the custody store/alias operations are deliberately NOT exposed
// in this bounded first cut.
//
// Per the memory-tools v2.2 rule: required fields go in the parent
// `required: [...]` array, never as `required: true` on a property.

export const CUSTODY_TOOLS_SCHEMA = [
  {
    name: "custody_resolve_alias",
    description:
      "Resolve a stable NeuralSynch custody alias to its immutable artifact version. Returns version_id, artifact_id, sha256, byte_length and custody_state. METADATA ONLY — call custody_retrieve to get the actual file. Example alias: project:neuralsynch-custody/acceptance-test/current",
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        alias: {
          type: "string",
          description:
            "The custody alias to resolve, e.g. project:neuralsynch-custody/acceptance-test/current",
        },
        client_id: {
          type: "string",
          description: "Client identifier (default: neuralsynch)",
          default: NS_DEFAULT_CLIENT,
        },
        project: {
          type: "string",
          description: "Custody project (default: neuralsynch-custody)",
          default: NS_DEFAULT_PROJECT,
        },
      },
      required: ["alias"],
    },
  },
  {
    name: "custody_get_metadata",
    description:
      "Get full metadata for one custody artifact version: sha256, byte_length, media_type, custody_state, filenames and timestamps. METADATA ONLY — returns no file content.",
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        version_id: {
          type: "string",
          description: "Custody artifact version UUID",
        },
      },
      required: ["version_id"],
    },
  },
  {
    name: "custody_retrieve",
    description:
      "Retrieve the ACTUAL FILE BYTES of a custody artifact version, base64-encoded, after the custody service has re-read and re-hashed them server-side. Fails closed with ARTIFACT_HASH_MISMATCH or ARTIFACT_BYTES_MISSING rather than returning a path, a URL or a stale reference. Always recompute the SHA-256 yourself and compare it with the returned sha256.",
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        version_id: {
          type: "string",
          description: "Custody artifact version UUID",
        },
      },
      required: ["version_id"],
    },
  },
  {
    name: "custody_verify",
    description:
      "Verify a custody artifact is still intact without handling the payload. Returns verified true/false plus sha256 and byte_length, or a typed failure code.",
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        version_id: {
          type: "string",
          description: "Custody artifact version UUID",
        },
      },
      required: ["version_id"],
    },
  },
  // ─── S252 governed-write + extended-read custody tools ────────────────
  {
    name: "custody_store",
    description:
      "Store the ACTUAL BYTES of an artifact as a new IMMUTABLE custody version, scoped to a client_id/project. The bytes are sent base64-encoded (single-shot, 8 MB base64 max — there is no multipart path). The backend computes the SHA-256 and byte length server-side, reads the object back and re-hashes it; only a matching read-back reaches custody_state CUSTODIED, otherwise it fails closed (VERIFICATION_FAILURE) and no partial success is reported. Storing the same artifact_name again creates a NEW version and never overwrites existing bytes. Authorisation is enforced server-side against project membership using the server-held custody credential; the caller never sends a key. created_through records provenance (default claude-app).",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        client_id: {
          type: "string",
          description: "Client identifier (default: neuralsynch)",
          default: NS_DEFAULT_CLIENT,
        },
        project: {
          type: "string",
          description:
            "Project scope the write is authorised against, e.g. publishing-studio",
        },
        artifact_name: {
          type: "string",
          description:
            "Logical artifact name; storing the same name again adds a new immutable version",
        },
        filename: {
          type: "string",
          description:
            "Original filename; used to derive the safe filename and media type",
        },
        content_base64: {
          type: "string",
          description:
            "The artifact bytes, base64-encoded. Max 8 MB of base64 text; larger payloads fail closed (no multipart).",
        },
        created_through: {
          type: "string",
          description:
            "Provenance label for this version: claude-app (default), claude-code, chatgpt, studio or website",
          default: NS_DEFAULT_PROVENANCE,
        },
      },
      required: ["project", "artifact_name", "filename", "content_base64"],
    },
  },
  {
    name: "custody_begin_upload",
    description:
      "Begin a governed direct upload using METADATA ONLY. Authorizes the server-held principal for client_id/project, records the expected SHA-256 and byte length, creates a unique private pending path and returns a short-lived signed PUT URL plus the exact headers. File bytes must travel directly from local disk to Supabase Storage, never as model-generated base64. The application finalization window is 15 minutes; the signed URL/token must never be logged, persisted, committed or reported.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        client_id: {
          type: "string",
          description: "Client identifier (default: neuralsynch)",
          default: NS_DEFAULT_CLIENT,
        },
        project: {
          type: "string",
          description: "Authorized custody project, e.g. publishing-studio",
        },
        artifact_name: {
          type: "string",
          description:
            "Logical artifact name; finalization creates a new immutable version",
        },
        filename: {
          type: "string",
          description:
            "Single original file name; paths and traversal are rejected",
        },
        expected_sha256: {
          type: "string",
          description:
            "Required 64-character lowercase SHA-256 of the local file",
        },
        expected_byte_length: {
          type: "integer",
          description:
            "Required local file byte length, from 1 through 104857600",
          minimum: 1,
          maximum: 104857600,
        },
        media_type: {
          type: "string",
          description: "File media type, e.g. application/zip",
        },
        created_through: {
          type: "string",
          description: "Provenance label (default: claude-app)",
          default: NS_DEFAULT_PROVENANCE,
        },
        logical_project_path: {
          type: "string",
          description:
            "Optional relative logical project path; never used as the storage path",
        },
        classification: {
          type: "string",
          description:
            "Optional existing artifact classification or status label to preserve in the authoritative catalog",
        },
      },
      required: [
        "project",
        "artifact_name",
        "filename",
        "expected_sha256",
        "expected_byte_length",
        "media_type",
      ],
    },
  },
  {
    name: "custody_finalize_upload",
    description:
      "Finalize one governed pending upload exactly once. Reauthorizes its original client/project/principal, rejects expired or replayed uploads, reads and hashes the pending object server-side, compares SHA-256 and byte length, promotes verified bytes into a new immutable permanent version, reads it back and verifies it again, then marks it CUSTODIED. Hash or length mismatches fail closed and remove the pending object. No alias can target the version before successful finalization.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        upload_id: {
          type: "string",
          description: "Pending upload UUID returned by custody_begin_upload",
        },
      },
      required: ["upload_id"],
    },
  },
  {
    name: "custody_set_alias",
    description:
      "Point a stable custody alias at an immutable version within a client_id/project. The target version must already exist in the same client_id/project or the call fails ALIAS_TARGET_MISSING. Re-pointing an existing alias records an auditable event and moves the pointer only — it never mutates or deletes stored bytes. Requires a write-capable project role, enforced server-side.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        client_id: {
          type: "string",
          description: "Client identifier (default: neuralsynch)",
          default: NS_DEFAULT_CLIENT,
        },
        project: {
          type: "string",
          description: "Project scope, e.g. publishing-studio",
        },
        alias: {
          type: "string",
          description:
            "The alias to set, e.g. project:publishing-studio/current-handoff",
        },
        version_id: {
          type: "string",
          description: "The immutable version UUID the alias should resolve to",
        },
      },
      required: ["project", "alias", "version_id"],
    },
  },
  {
    name: "custody_list_versions",
    description:
      "List the immutable version history of one artifact_name within a client_id/project, oldest first, with sha256, byte_length, custody_state, created_at and created_by for each. Read-only. Fails ARTIFACT_NOT_FOUND if the artifact_name has no versions in that project.",
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        client_id: {
          type: "string",
          description: "Client identifier (default: neuralsynch)",
          default: NS_DEFAULT_CLIENT,
        },
        project: {
          type: "string",
          description: "Project scope, e.g. publishing-studio",
        },
        artifact_name: {
          type: "string",
          description: "Logical artifact name to list versions for",
        },
      },
      required: ["project", "artifact_name"],
    },
  },
  {
    name: "custody_add_dependency",
    description:
      "Record a directed, auditable dependency edge between two immutable versions (from → to). dep_type is a FIXED vocabulary: CONTAINS, DEPENDS_ON, GENERATED_FROM, SUPERSEDES, DOCUMENTS, VERIFIES, PACKAGES, REFERENCES. The target version must already exist or the call fails DEPENDENCY_MISSING. Edges are additive; re-adding an identical edge is a no-op. Requires a write-capable project role, enforced server-side against the from-version’s project.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        from_version_id: {
          type: "string",
          description: "Source version UUID (the dependent)",
        },
        to_version_id: {
          type: "string",
          description:
            "Target version UUID (the dependency); must already exist",
        },
        dep_type: {
          type: "string",
          description:
            "One of: CONTAINS, DEPENDS_ON, GENERATED_FROM, SUPERSEDES, DOCUMENTS, VERIFIES, PACKAGES, REFERENCES",
          enum: [
            "CONTAINS",
            "DEPENDS_ON",
            "GENERATED_FROM",
            "SUPERSEDES",
            "DOCUMENTS",
            "VERIFIES",
            "PACKAGES",
            "REFERENCES",
          ],
        },
      },
      required: ["from_version_id", "to_version_id", "dep_type"],
    },
  },
  {
    name: "custody_dependency_closure",
    description:
      "Return the complete transitive dependency graph reachable from a root version: every member version plus missing_version_ids for any referenced version whose row is absent. Read-only. Use it to prove a continuation set is complete before relying on it — anything in missing_version_ids must be recovered first.",
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        root_version_id: {
          type: "string",
          description:
            "The version UUID to compute the dependency closure from",
        },
      },
      required: ["root_version_id"],
    },
  },
  {
    name: "custody_export_session",
    description:
      "Export the dependency closure of a root version as a single self-contained ZIP (base64) containing every retrievable member plus MANIFEST.json and SHA256SUMS.txt, and record an export row. Each member is re-verified during export; complete=false or a non-empty missing[] means the closure could not be fully reconstructed. Intended to reconstruct a continuation set in a fresh session. Requires an export-capable project role, enforced server-side.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        root_version_id: {
          type: "string",
          description:
            "The version UUID whose dependency closure should be exported",
        },
      },
      required: ["root_version_id"],
    },
  },
  {
    name: "custody_scan_archive",
    description:
      "Inventory a stored ZIP artifact from its central directory and record the entries. Reports entry_count, nested_archives, unsafe (absolute/traversal) paths, duplicates, encrypted entries and unsupported compression. LIMITATIONS: it does NOT recurse into nested archives, does NOT compute per-entry hashes, treats only store/deflate as supported, and returns at most 200 entries inline. Fails ARCHIVE_UNSUPPORTED or ARCHIVE_LIMIT_EXCEEDED on malformed or oversized archives.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        version_id: {
          type: "string",
          description: "Custody artifact version UUID of the ZIP to scan",
        },
      },
      required: ["version_id"],
    },
  },
  {
    name: "custody_report_missing",
    description:
      "Report the live custody status of a version without transferring the payload: CUSTODIED (bytes present and SHA-256 matches), or a typed condition — ARTIFACT_NOT_FOUND, ARTIFACT_BYTES_MISSING or ARTIFACT_HASH_MISMATCH. Read-only. Use it to detect absent or corrupted dependencies before a handoff.",
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        version_id: {
          type: "string",
          description: "Custody artifact version UUID to check",
        },
      },
      required: ["version_id"],
    },
  },
];
