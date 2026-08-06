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
  'https://udafklielwqdppnagtwc.supabase.co/functions/v1/neuralsync-custody';

const NS_DEFAULT_CLIENT = 'neuralsynch';
const NS_DEFAULT_PROJECT = 'neuralsynch-custody';

export interface CustodyToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/** The one and only environment variable this server reads for custody auth. */
export const CUSTODY_KEY_ENV = 'NEURALSYNC_CHATGPT_CUSTODY_KEY';

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
  const key = resolveCustodyKey() ?? '';
  let out = s;
  if (key) out = out.split(key).join('[REDACTED]');
  return out
    .replace(/nsck_[0-9a-fA-F]{8,}/g, '[REDACTED]')
    .replace(/eyJ[A-Za-z0-9_\-.]{20,}/g, '[REDACTED]')
    .replace(/sb_secret_[A-Za-z0-9_\-]+/g, '[REDACTED]')
    .replace(/sb_publishable_[A-Za-z0-9_\-]+/g, '[REDACTED]')
    .replace(/(x-custody-key)["'\s:=]+[^"'\s,}]+/gi, '$1: [REDACTED]');
}

/**
 * Call the deployed custody Edge Function server-side.
 * The key is attached here and nowhere else. It is never returned to the caller.
 */
export async function custodyCall(
  op: string,
  args: Record<string, unknown>,
): Promise<any> {
  const key = resolveCustodyKey();
  if (!key) {
    throw new Error(
      `CUSTODY_KEY_NOT_CONFIGURED: no custody key is bound to this MCP server. ` +
        `Set the environment variable ${CUSTODY_KEY_ENV} on this deployment. ` +
        `No other variable name is read. Custody tools are unavailable until it is set.`,
    );
  }

  const res = await fetch(CUSTODY_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-custody-key': key,
    },
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
    const code = data?.error?.code ?? 'VERIFICATION_FAILURE';
    const detail = redact(String(data?.error?.detail ?? `HTTP ${res.status}`));
    throw new Error(`${code}: ${detail}`);
  }
  return data.result;
}

export class CustodyToolHandler {
  // ─── custody_resolve_alias ───────────────────────────────────────────
  async handleResolveAlias(args: any): Promise<CustodyToolResult> {
    if (!args?.alias || typeof args.alias !== 'string') {
      throw new Error('alias is required for custody_resolve_alias');
    }
    const r = await custodyCall('resolve_alias', {
      client_id: args.client_id || NS_DEFAULT_CLIENT,
      project: args.project || NS_DEFAULT_PROJECT,
      alias: args.alias,
    });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          alias: r.alias,
          version_id: r.version_id,
          artifact_id: r.artifact_id,
          sha256: r.sha256,
          byte_length: r.byte_length,
          custody_state: r.custody_state,
          safe_filename: r.safe_filename,
          note:
            'METADATA ONLY. Call custody_retrieve with this version_id to get the actual file bytes.',
        }, null, 2),
      }],
    };
  }

  // ─── custody_get_metadata ────────────────────────────────────────────
  async handleGetMetadata(args: any): Promise<CustodyToolResult> {
    if (!args?.version_id || typeof args.version_id !== 'string') {
      throw new Error('version_id is required for custody_get_metadata');
    }
    const r = await custodyCall('get_metadata', { version_id: args.version_id });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          version_id: r.id ?? r.version_id,
          artifact_id: r.artifact_id,
          client_id: r.client_id,
          project: r.project,
          sha256: r.sha256,
          byte_length: r.byte_length,
          media_type: r.media_type,
          original_filename: r.original_filename,
          safe_filename: r.safe_filename,
          custody_state: r.custody_state,
          created_by: r.created_by,
          created_through: r.created_through,
          created_at: r.created_at,
          verified_at: r.verified_at,
          note: 'METADATA ONLY — no bytes returned.',
        }, null, 2),
      }],
    };
  }

  // ─── custody_retrieve ────────────────────────────────────────────────
  async handleRetrieve(args: any): Promise<CustodyToolResult> {
    if (!args?.version_id || typeof args.version_id !== 'string') {
      throw new Error('version_id is required for custody_retrieve');
    }
    const r = await custodyCall('retrieve', { version_id: args.version_id });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          version_id: r.version_id,
          safe_filename: r.safe_filename,
          sha256: r.sha256,
          byte_length: r.byte_length,
          media_type: r.media_type,
          custody_state: r.custody_state,
          encoding: 'base64',
          content_base64: r.content_base64,
          instruction:
            `Decode content_base64, write it to disk, recompute SHA-256 and confirm it equals ${r.sha256} before treating this file as retrieved. The custody service already verified it server-side; verifying again is the point of custody.`,
        }, null, 2),
      }],
    };
  }

  // ─── custody_verify ──────────────────────────────────────────────────
  async handleVerify(args: any): Promise<CustodyToolResult> {
    if (!args?.version_id || typeof args.version_id !== 'string') {
      throw new Error('version_id is required for custody_verify');
    }
    const r = await custodyCall('verify', { version_id: args.version_id });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          version_id: r.version_id,
          verified: r.verified === true,
          sha256: r.sha256,
          byte_length: r.byte_length,
          custody_state: r.custody_state,
          code: r.code,
          note: r.verified === true
            ? 'Bytes were re-read and re-hashed server-side and match the recorded SHA-256.'
            : 'VERIFICATION FAILED — do not substitute a path, URL or legacy Vault record for this artifact.',
        }, null, 2),
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
    name: 'custody_resolve_alias',
    description:
      'Resolve a stable NeuralSynch custody alias to its immutable artifact version. Returns version_id, artifact_id, sha256, byte_length and custody_state. METADATA ONLY — call custody_retrieve to get the actual file. Example alias: project:neuralsynch-custody/acceptance-test/current',
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        alias: {
          type: 'string',
          description: 'The custody alias to resolve, e.g. project:neuralsynch-custody/acceptance-test/current',
        },
        client_id: {
          type: 'string',
          description: 'Client identifier (default: neuralsynch)',
          default: NS_DEFAULT_CLIENT,
        },
        project: {
          type: 'string',
          description: 'Custody project (default: neuralsynch-custody)',
          default: NS_DEFAULT_PROJECT,
        },
      },
      required: ['alias'],
    },
  },
  {
    name: 'custody_get_metadata',
    description:
      'Get full metadata for one custody artifact version: sha256, byte_length, media_type, custody_state, filenames and timestamps. METADATA ONLY — returns no file content.',
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        version_id: {
          type: 'string',
          description: 'Custody artifact version UUID',
        },
      },
      required: ['version_id'],
    },
  },
  {
    name: 'custody_retrieve',
    description:
      'Retrieve the ACTUAL FILE BYTES of a custody artifact version, base64-encoded, after the custody service has re-read and re-hashed them server-side. Fails closed with ARTIFACT_HASH_MISMATCH or ARTIFACT_BYTES_MISSING rather than returning a path, a URL or a stale reference. Always recompute the SHA-256 yourself and compare it with the returned sha256.',
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        version_id: {
          type: 'string',
          description: 'Custody artifact version UUID',
        },
      },
      required: ['version_id'],
    },
  },
  {
    name: 'custody_verify',
    description:
      'Verify a custody artifact is still intact without handling the payload. Returns verified true/false plus sha256 and byte_length, or a typed failure code.',
    annotations: {
      readOnlyHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        version_id: {
          type: 'string',
          description: 'Custody artifact version UUID',
        },
      },
      required: ['version_id'],
    },
  },
];
