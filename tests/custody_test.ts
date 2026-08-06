// Custody transport tests — key resolution, redaction, fail-closed behaviour.
//
// Every test here is OFFLINE. globalThis.fetch is stubbed, so nothing touches
// production and no real custody key is needed.
//
// Run: deno test --allow-env tests/custody_test.ts

import { assert, assertEquals, assertRejects, assertStringIncludes } from 'jsr:@std/assert@^1.0.0';
import {
  CUSTODY_ENDPOINT,
  CUSTODY_KEY_ENV,
  CustodyToolHandler,
  custodyCall,
  redact,
  resolveCustodyKey,
} from '../custody-tools.ts';

// The retired name. It appears in this file ONLY as the subject of the test
// that proves it is ignored — never as a supported configuration path.
const RETIRED_ENV = 'NS_CUSTODY_KEY';

const FAKE_KEY = 'nsck_' + 'a'.repeat(64);

function clearKeys() {
  Deno.env.delete(CUSTODY_KEY_ENV);
  Deno.env.delete(RETIRED_ENV);
}

/** Replace fetch for one call, capturing what the server was sent. */
function stubFetch(response: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((url: any, init: any) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(
      new Response(JSON.stringify(response), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

// ─── key resolution ────────────────────────────────────────────────────

Deno.test('the only env var read is NEURALSYNC_CHATGPT_CUSTODY_KEY', () => {
  assertEquals(CUSTODY_KEY_ENV, 'NEURALSYNC_CHATGPT_CUSTODY_KEY');
  clearKeys();
  Deno.env.set(CUSTODY_KEY_ENV, 'primary-value');
  assertEquals(resolveCustodyKey(), 'primary-value');
  clearKeys();
});

Deno.test('resolveCustodyKey returns undefined when it is unset', () => {
  clearKeys();
  assertEquals(resolveCustodyKey(), undefined);
});

// ─── the retired fallback is genuinely gone ────────────────────────────

Deno.test('NS_CUSTODY_KEY alone is IGNORED — no fallback survives', () => {
  clearKeys();
  Deno.env.set(RETIRED_ENV, 'nsck_' + 'f'.repeat(64));
  assertEquals(
    resolveCustodyKey(),
    undefined,
    'the retired NS_CUSTODY_KEY name is still being read as a fallback',
  );
  clearKeys();
});

Deno.test('NS_CUSTODY_KEY alone makes custody calls FAIL, and no request is sent', async () => {
  clearKeys();
  Deno.env.set(RETIRED_ENV, 'nsck_' + 'f'.repeat(64));

  // Stub fetch so an accidental fallback would be caught as a real request
  // rather than passing silently.
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((url: any) => {
    calls.push(String(url));
    return Promise.resolve(new Response('{"ok":true,"result":{}}', { status: 200 }));
  }) as typeof fetch;

  try {
    const err = await assertRejects(
      () => custodyCall('verify', { version_id: 'v1' }),
      Error,
    );
    assertStringIncludes(err.message, 'CUSTODY_KEY_NOT_CONFIGURED');
    assertStringIncludes(err.message, 'NEURALSYNC_CHATGPT_CUSTODY_KEY');
    assertEquals(calls.length, 0, 'a request was sent using the retired fallback key');
  } finally {
    globalThis.fetch = original;
    clearKeys();
  }
});

Deno.test('a custody tool call fails closed when only the retired name is set', async () => {
  clearKeys();
  Deno.env.set(RETIRED_ENV, 'nsck_' + 'f'.repeat(64));
  try {
    await assertRejects(
      () => new CustodyToolHandler().handleVerify({ version_id: 'v1' }),
      Error,
      'CUSTODY_KEY_NOT_CONFIGURED',
    );
  } finally {
    clearKeys();
  }
});

// ─── fail closed with no key ───────────────────────────────────────────

Deno.test('custodyCall fails loudly when no key is bound', async () => {
  clearKeys();
  const err = await assertRejects(() => custodyCall('verify', { version_id: 'x' }), Error);
  assertStringIncludes(err.message, 'CUSTODY_KEY_NOT_CONFIGURED');
  assertStringIncludes(err.message, 'NEURALSYNC_CHATGPT_CUSTODY_KEY');
});

// ─── redaction ─────────────────────────────────────────────────────────

Deno.test('redact removes the literal configured key', () => {
  clearKeys();
  Deno.env.set(CUSTODY_KEY_ENV, FAKE_KEY);
  const out = redact(`request failed using ${FAKE_KEY} at the edge`);
  assert(!out.includes(FAKE_KEY), 'literal key survived redaction');
  assertStringIncludes(out, '[REDACTED]');
  clearKeys();
});

Deno.test('redact removes credential shapes even when no key is configured', () => {
  clearKeys();
  const samples: Array<[string, string]> = [
    ['leaked nsck_0123456789abcdef0123 here', 'nsck_'],
    ['bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdefghij', 'eyJ'],
    ['key sb_secret_abcdefghijklmnop', 'sb_secret_'],
    ['key sb_publishable_abcdefghijklmnop', 'sb_publishable_'],
  ];
  for (const [input, shape] of samples) {
    const out = redact(input);
    assert(!out.includes(shape), `${shape} survived redaction: ${out}`);
    assertStringIncludes(out, '[REDACTED]');
  }
});

Deno.test('redact masks an x-custody-key header value but keeps the header name', () => {
  clearKeys();
  const out = redact('{"x-custody-key": "nsck_deadbeefdeadbeef"}');
  assertStringIncludes(out, 'x-custody-key');
  assert(!out.includes('deadbeef'), `header value survived: ${out}`);
});

Deno.test('redact is a no-op on clean text', () => {
  clearKeys();
  const clean = 'ALIAS_NOT_FOUND: no alias project:x/y/current for client neuralsynch';
  assertEquals(redact(clean), clean);
});

// ─── transport ─────────────────────────────────────────────────────────

Deno.test('custodyCall sends the key ONLY in the x-custody-key header', async () => {
  clearKeys();
  Deno.env.set(CUSTODY_KEY_ENV, FAKE_KEY);
  const stub = stubFetch({ ok: true, result: { verified: true } });
  try {
    await custodyCall('verify', { version_id: 'v1' });
    assertEquals(stub.calls.length, 1);
    const { url, init } = stub.calls[0];
    assertEquals(url, CUSTODY_ENDPOINT);
    assertEquals((init.headers as any)['x-custody-key'], FAKE_KEY);
    // The key must never appear in the request body.
    assert(!String(init.body).includes(FAKE_KEY), 'key leaked into request body');
  } finally {
    stub.restore();
    clearKeys();
  }
});

Deno.test('typed custody errors are surfaced verbatim, not collapsed', async () => {
  clearKeys();
  Deno.env.set(CUSTODY_KEY_ENV, FAKE_KEY);
  const stub = stubFetch({ ok: false, error: { code: 'ALIAS_NOT_FOUND', detail: 'no such alias' } });
  try {
    const err = await assertRejects(
      () => custodyCall('resolve_alias', { alias: 'nope' }),
      Error,
    );
    assertStringIncludes(err.message, 'ALIAS_NOT_FOUND');
    assertStringIncludes(err.message, 'no such alias');
  } finally {
    stub.restore();
    clearKeys();
  }
});

Deno.test('a custody error detail containing the key is redacted before it escapes', async () => {
  clearKeys();
  Deno.env.set(CUSTODY_KEY_ENV, FAKE_KEY);
  const stub = stubFetch({
    ok: false,
    error: { code: 'UNAUTHORIZED', detail: `rejected key ${FAKE_KEY}` },
  });
  try {
    const err = await assertRejects(() => custodyCall('verify', { version_id: 'v' }), Error);
    assert(!err.message.includes(FAKE_KEY), `key leaked through error: ${err.message}`);
    assertStringIncludes(err.message, '[REDACTED]');
  } finally {
    stub.restore();
    clearKeys();
  }
});

// ─── handlers ──────────────────────────────────────────────────────────

Deno.test('custody_resolve_alias returns metadata and no bytes', async () => {
  clearKeys();
  Deno.env.set(CUSTODY_KEY_ENV, FAKE_KEY);
  const stub = stubFetch({
    ok: true,
    result: {
      alias: 'project:neuralsynch-custody/acceptance-test/current',
      version_id: 'f509c795-367c-46d4-af79-536ae7f8d402',
      artifact_id: '2fbcc5e2-7e9f-4acc-b740-2c3714c95e81',
      sha256: 'a64a995f',
      byte_length: 41173,
      custody_state: 'CUSTODIED',
      safe_filename: 'x.zip',
    },
  });
  try {
    const out = await new CustodyToolHandler().handleResolveAlias({ alias: 'a' });
    const parsed = JSON.parse(out.content[0].text);
    assertEquals(parsed.version_id, 'f509c795-367c-46d4-af79-536ae7f8d402');
    assertEquals(parsed.custody_state, 'CUSTODIED');
    assert(!('content_base64' in parsed), 'alias resolution must not return bytes');
    assert(!out.content[0].text.includes(FAKE_KEY), 'key leaked into tool result');
  } finally {
    stub.restore();
    clearKeys();
  }
});

Deno.test('custody_get_metadata returns metadata and no bytes', async () => {
  clearKeys();
  Deno.env.set(CUSTODY_KEY_ENV, FAKE_KEY);
  const stub = stubFetch({
    ok: true,
    result: {
      id: 'v1',
      sha256: 'abc',
      byte_length: 10,
      logical_project_path: 'handoffs/demo.zip',
      classification: 'APPROVED_HANDOFF',
      custody_state: 'CUSTODIED',
    },
  });
  try {
    const out = await new CustodyToolHandler().handleGetMetadata({ version_id: 'v1' });
    const parsed = JSON.parse(out.content[0].text);
    assertEquals(parsed.version_id, 'v1');
    assertEquals(parsed.logical_project_path, 'handoffs/demo.zip');
    assertEquals(parsed.classification, 'APPROVED_HANDOFF');
    assert(!('content_base64' in parsed), 'metadata must not return bytes');
  } finally {
    stub.restore();
    clearKeys();
  }
});

Deno.test('custody_retrieve returns bytes plus the hash to check them against', async () => {
  clearKeys();
  Deno.env.set(CUSTODY_KEY_ENV, FAKE_KEY);
  const stub = stubFetch({
    ok: true,
    result: {
      version_id: 'v1',
      sha256: 'a64a995f',
      byte_length: 3,
      content_base64: 'YWJj',
      safe_filename: 'x.zip',
      custody_state: 'CUSTODIED',
    },
  });
  try {
    const out = await new CustodyToolHandler().handleRetrieve({ version_id: 'v1' });
    const parsed = JSON.parse(out.content[0].text);
    assertEquals(parsed.content_base64, 'YWJj');
    assertEquals(parsed.encoding, 'base64');
    assertStringIncludes(parsed.instruction, 'a64a995f');
    assert(!out.content[0].text.includes(FAKE_KEY), 'key leaked into tool result');
  } finally {
    stub.restore();
    clearKeys();
  }
});

Deno.test('custody_verify reports a failed verification as failed', async () => {
  clearKeys();
  Deno.env.set(CUSTODY_KEY_ENV, FAKE_KEY);
  const stub = stubFetch({
    ok: true,
    result: { version_id: 'v1', verified: false, code: 'ARTIFACT_HASH_MISMATCH' },
  });
  try {
    const out = await new CustodyToolHandler().handleVerify({ version_id: 'v1' });
    const parsed = JSON.parse(out.content[0].text);
    assertEquals(parsed.verified, false);
    assertEquals(parsed.code, 'ARTIFACT_HASH_MISMATCH');
    assertStringIncludes(parsed.note, 'VERIFICATION FAILED');
  } finally {
    stub.restore();
    clearKeys();
  }
});

Deno.test('custody handlers reject missing required arguments before any network call', async () => {
  clearKeys();
  Deno.env.set(CUSTODY_KEY_ENV, FAKE_KEY);
  const h = new CustodyToolHandler();
  await assertRejects(() => h.handleResolveAlias({}), Error, 'alias is required');
  await assertRejects(() => h.handleGetMetadata({}), Error, 'version_id is required');
  await assertRejects(() => h.handleRetrieve({}), Error, 'version_id is required');
  await assertRejects(() => h.handleVerify({}), Error, 'version_id is required');
  clearKeys();
});

// ═══════════════════════════════════════════════════════════════════════
// S252 — governed writes + extended reads. Offline: fetch is stubbed, the op
// and args sent to the backend are captured and asserted, and no real key is
// used. These prove the MCP surface DELEGATES to the correct backend wire op
// with the correct arguments — they do not re-test backend policy.
// ═══════════════════════════════════════════════════════════════════════

/** The wire op + args the handler sent to the backend, from a stubbed call. */
function sentOp(init: RequestInit): { op: string; args: any } {
  return JSON.parse(String(init.body));
}

Deno.test('custody_store delegates to the store op and defaults provenance to claude-app', async () => {
  clearKeys();
  Deno.env.set(CUSTODY_KEY_ENV, FAKE_KEY);
  const stub = stubFetch({
    ok: true,
    result: {
      artifact_id: 'a1',
      version_id: 'v1',
      sha256: 'a'.repeat(64),
      byte_length: 3,
      media_type: 'application/zip',
      custody_state: 'CUSTODIED',
      verified_at: '2026-08-06T00:00:00Z',
    },
  });
  try {
    const out = await new CustodyToolHandler().handleStore({
      project: 'publishing-studio',
      artifact_name: 'demo',
      filename: 'demo.zip',
      content_base64: 'YWJj',
    });
    const { op, args } = sentOp(stub.calls[0].init);
    assertEquals(op, 'store');
    assertEquals(args.project, 'publishing-studio');
    assertEquals(args.client_id, 'neuralsynch');
    assertEquals(args.created_through, 'claude-app');
    const parsed = JSON.parse(out.content[0].text);
    assertEquals(parsed.version_id, 'v1');
    assertEquals(parsed.custody_state, 'CUSTODIED');
    assert(!out.content[0].text.includes(FAKE_KEY), 'key leaked into tool result');
  } finally {
    stub.restore();
    clearKeys();
  }
});

Deno.test('custody_store honours an explicit compatible provenance', async () => {
  clearKeys();
  Deno.env.set(CUSTODY_KEY_ENV, FAKE_KEY);
  const stub = stubFetch({ ok: true, result: { version_id: 'v2', custody_state: 'CUSTODIED' } });
  try {
    await new CustodyToolHandler().handleStore({
      project: 'publishing-studio',
      artifact_name: 'demo',
      filename: 'demo.zip',
      content_base64: 'YWJj',
      created_through: 'studio',
    });
    assertEquals(sentOp(stub.calls[0].init).args.created_through, 'studio');
  } finally {
    stub.restore();
    clearKeys();
  }
});

Deno.test('custody_store rejects an unrecognised provenance without a network call', async () => {
  clearKeys();
  Deno.env.set(CUSTODY_KEY_ENV, FAKE_KEY);
  const stub = stubFetch({ ok: true, result: {} });
  try {
    await assertRejects(
      () =>
        new CustodyToolHandler().handleStore({
          project: 'publishing-studio',
          artifact_name: 'demo',
          filename: 'demo.zip',
          content_base64: 'YWJj',
          created_through: 'rogue-agent',
        }),
      Error,
      'created_through must be one of',
    );
    assertEquals(stub.calls.length, 0, 'a store request was sent with bad provenance');
  } finally {
    stub.restore();
    clearKeys();
  }
});

Deno.test('custody_store fails closed above the 8 MB base64 limit with no false multipart claim', async () => {
  clearKeys();
  Deno.env.set(CUSTODY_KEY_ENV, FAKE_KEY);
  const stub = stubFetch({ ok: true, result: {} });
  try {
    const tooBig = 'A'.repeat(8 * 1024 * 1024 + 8);
    const err = await assertRejects(
      () =>
        new CustodyToolHandler().handleStore({
          project: 'publishing-studio',
          artifact_name: 'big',
          filename: 'big.zip',
          content_base64: tooBig,
        }),
      Error,
    );
    assertStringIncludes(err.message, 'PAYLOAD_TOO_LARGE');
    assertStringIncludes(err.message, 'multipart is NOT implemented');
    assertEquals(stub.calls.length, 0, 'oversized payload was sent to the backend');
  } finally {
    stub.restore();
    clearKeys();
  }
});

Deno.test('custody_begin_upload validates metadata and delegates to begin_upload without file bytes', async () => {
  clearKeys();
  Deno.env.set(CUSTODY_KEY_ENV, FAKE_KEY);
  const stub = stubFetch({
    ok: true,
    result: {
      upload_id: '11111111-1111-4111-8111-111111111111',
      signed_upload_url: 'https://example.test/storage/v1/object/upload/sign/ns-artifacts/path?token=transient',
      method: 'PUT',
      headers: { 'Content-Type': 'application/zip', 'x-upsert': 'false' },
      application_expires_at: '2026-08-06T19:00:00Z',
      expected_sha256: 'a'.repeat(64),
      expected_byte_length: 123,
    },
  });
  try {
    const out = await new CustodyToolHandler().handleBeginUpload({
      project: 'publishing-studio',
      artifact_name: 'demo',
      filename: 'demo.zip',
      expected_sha256: 'a'.repeat(64),
      expected_byte_length: 123,
      media_type: 'application/zip',
      logical_project_path: 'handoffs/demo.zip',
      classification: 'APPROVED_HANDOFF',
    });
    const sent = sentOp(stub.calls[0].init);
    assertEquals(sent.op, 'begin_upload');
    assertEquals(sent.args.client_id, 'neuralsynch');
    assertEquals(sent.args.created_through, 'claude-app');
    assertEquals(sent.args.expected_byte_length, 123);
    assertEquals(sent.args.logical_project_path, 'handoffs/demo.zip');
    assertEquals(sent.args.classification, 'APPROVED_HANDOFF');
    assert(!('content_base64' in sent.args), 'begin_upload carried file bytes');
    const parsed = JSON.parse(out.content[0].text);
    assertEquals(parsed.method, 'PUT');
    assertEquals(parsed.upload_id, '11111111-1111-4111-8111-111111111111');
  } finally {
    stub.restore();
    clearKeys();
  }
});

Deno.test('custody_begin_upload rejects bad hash, length and traversal before any network call', async () => {
  clearKeys();
  Deno.env.set(CUSTODY_KEY_ENV, FAKE_KEY);
  const stub = stubFetch({ ok: true, result: {} });
  const h = new CustodyToolHandler();
  const base = { project: 'publishing-studio', artifact_name: 'demo', filename: 'demo.zip', expected_sha256: 'a'.repeat(64), expected_byte_length: 123, media_type: 'application/zip' };
  try {
    await assertRejects(() => h.handleBeginUpload({ ...base, expected_sha256: 'bad' }), Error, 'expected_sha256');
    await assertRejects(() => h.handleBeginUpload({ ...base, expected_byte_length: 104857601 }), Error, 'expected_byte_length');
    await assertRejects(() => h.handleBeginUpload({ ...base, filename: '../demo.zip' }), Error, 'traversal-free');
    await assertRejects(() => h.handleBeginUpload({ ...base, logical_project_path: '../secret' }), Error, 'logical_project_path');
    await assertRejects(() => h.handleBeginUpload({ ...base, classification: 'bad\nclassification' }), Error, 'classification');
    assertEquals(stub.calls.length, 0, 'invalid begin_upload metadata reached the backend');
  } finally {
    stub.restore();
    clearKeys();
  }
});

Deno.test('custody_finalize_upload delegates only the pending upload id and returns custody proof', async () => {
  clearKeys();
  Deno.env.set(CUSTODY_KEY_ENV, FAKE_KEY);
  const stub = stubFetch({
    ok: true,
    result: {
      artifact_id: 'a1',
      version_id: 'v1',
      sha256: 'a'.repeat(64),
      byte_length: 123,
      filename: 'demo.zip',
      media_type: 'application/zip',
      custody_state: 'CUSTODIED',
      created_through: 'claude-app',
      verified_at: '2026-08-06T19:00:00Z',
      temporary_object_removed: true,
    },
  });
  try {
    const out = await new CustodyToolHandler().handleFinalizeUpload({ upload_id: '11111111-1111-4111-8111-111111111111' });
    const sent = sentOp(stub.calls[0].init);
    assertEquals(sent.op, 'finalize_upload');
    assertEquals(sent.args, { upload_id: '11111111-1111-4111-8111-111111111111' });
    const parsed = JSON.parse(out.content[0].text);
    assertEquals(parsed.custody_state, 'CUSTODIED');
    assertEquals(parsed.temporary_object_removed, true);
  } finally {
    stub.restore();
    clearKeys();
  }
});

Deno.test('custody_finalize_upload surfaces typed backend errors verbatim', async () => {
  clearKeys();
  Deno.env.set(CUSTODY_KEY_ENV, FAKE_KEY);
  const stub = stubFetch({ ok: false, error: { code: 'UPLOAD_HASH_MISMATCH', detail: 'uploaded bytes do not match expected_sha256' } }, 409);
  try {
    const err = await assertRejects(
      () => new CustodyToolHandler().handleFinalizeUpload({ upload_id: '11111111-1111-4111-8111-111111111111' }),
      Error,
    );
    assertStringIncludes(err.message, 'UPLOAD_HASH_MISMATCH');
  } finally {
    stub.restore();
    clearKeys();
  }
});

Deno.test('custody_set_alias delegates to set_alias and surfaces ALIAS_TARGET_MISSING verbatim', async () => {
  clearKeys();
  Deno.env.set(CUSTODY_KEY_ENV, FAKE_KEY);
  const ok = stubFetch({ ok: true, result: { alias: 'project:publishing-studio/current-handoff', version_id: 'v1', ok: true } });
  try {
    const out = await new CustodyToolHandler().handleSetAlias({
      project: 'publishing-studio',
      alias: 'project:publishing-studio/current-handoff',
      version_id: 'v1',
    });
    assertEquals(sentOp(ok.calls[0].init).op, 'set_alias');
    assertEquals(JSON.parse(out.content[0].text).ok, true);
  } finally {
    ok.restore();
  }
  const bad = stubFetch({ ok: false, error: { code: 'ALIAS_TARGET_MISSING', detail: 'no such version' } });
  try {
    const err = await assertRejects(
      () => new CustodyToolHandler().handleSetAlias({ project: 'p', alias: 'a', version_id: 'nope' }),
      Error,
    );
    assertStringIncludes(err.message, 'ALIAS_TARGET_MISSING');
  } finally {
    bad.restore();
    clearKeys();
  }
});

Deno.test('custody_list_versions delegates to list_versions and returns history', async () => {
  clearKeys();
  Deno.env.set(CUSTODY_KEY_ENV, FAKE_KEY);
  const stub = stubFetch({
    ok: true,
    result: { artifact_name: 'demo', versions: [{ id: 'v1' }, { id: 'v2' }] },
  });
  try {
    const out = await new CustodyToolHandler().handleListVersions({ project: 'publishing-studio', artifact_name: 'demo' });
    assertEquals(sentOp(stub.calls[0].init).op, 'list_versions');
    assertEquals(JSON.parse(out.content[0].text).versions.length, 2);
  } finally {
    stub.restore();
    clearKeys();
  }
});

Deno.test('custody_add_dependency validates the fixed dep_type vocabulary before any network call', async () => {
  clearKeys();
  Deno.env.set(CUSTODY_KEY_ENV, FAKE_KEY);
  const stub = stubFetch({ ok: true, result: { ok: true } });
  try {
    await assertRejects(
      () => new CustodyToolHandler().handleAddDependency({ from_version_id: 'a', to_version_id: 'b', dep_type: 'INVENTED' }),
      Error,
      'dep_type must be one of',
    );
    assertEquals(stub.calls.length, 0, 'an invalid dep_type reached the backend');

    await new CustodyToolHandler().handleAddDependency({ from_version_id: 'a', to_version_id: 'b', dep_type: 'PACKAGES' });
    const { op, args } = sentOp(stub.calls[0].init);
    assertEquals(op, 'add_dependency');
    assertEquals(args.dep_type, 'PACKAGES');
  } finally {
    stub.restore();
    clearKeys();
  }
});

Deno.test('custody_dependency_closure delegates and reports members and missing ids', async () => {
  clearKeys();
  Deno.env.set(CUSTODY_KEY_ENV, FAKE_KEY);
  const stub = stubFetch({
    ok: true,
    result: { root: 'r', members: [{ id: 'r' }, { id: 'c' }], missing_version_ids: ['x'] },
  });
  try {
    const out = await new CustodyToolHandler().handleDependencyClosure({ root_version_id: 'r' });
    assertEquals(sentOp(stub.calls[0].init).op, 'dependency_closure');
    const parsed = JSON.parse(out.content[0].text);
    assertEquals(parsed.members.length, 2);
    assertEquals(parsed.missing_version_ids, ['x']);
  } finally {
    stub.restore();
    clearKeys();
  }
});

Deno.test('custody_export_session delegates and returns a base64 package with a completeness flag', async () => {
  clearKeys();
  Deno.env.set(CUSTODY_KEY_ENV, FAKE_KEY);
  const stub = stubFetch({
    ok: true,
    result: { export_id: 'e1', sha256: 'b'.repeat(64), byte_length: 42, complete: true, missing: [], content_base64: 'UEsFBg==' },
  });
  try {
    const out = await new CustodyToolHandler().handleExportSession({ root_version_id: 'r' });
    assertEquals(sentOp(stub.calls[0].init).op, 'export_session');
    const parsed = JSON.parse(out.content[0].text);
    assertEquals(parsed.encoding, 'base64');
    assertEquals(parsed.complete, true);
    assertEquals(parsed.content_base64, 'UEsFBg==');
  } finally {
    stub.restore();
    clearKeys();
  }
});

Deno.test('custody_scan_archive delegates and surfaces the inventory summary', async () => {
  clearKeys();
  Deno.env.set(CUSTODY_KEY_ENV, FAKE_KEY);
  const stub = stubFetch({
    ok: true,
    result: { archive_version_id: 'v1', entry_count: 5, unsafe_entries: 0, duplicate_entries: 0, encrypted_present: false, unsupported_present: false, nested_archives: 1, entries: [] },
  });
  try {
    const out = await new CustodyToolHandler().handleScanArchive({ version_id: 'v1' });
    assertEquals(sentOp(stub.calls[0].init).op, 'scan_archive');
    const parsed = JSON.parse(out.content[0].text);
    assertEquals(parsed.entry_count, 5);
    assertEquals(parsed.nested_archives, 1);
  } finally {
    stub.restore();
    clearKeys();
  }
});

Deno.test('custody_report_missing delegates and returns the live status', async () => {
  clearKeys();
  Deno.env.set(CUSTODY_KEY_ENV, FAKE_KEY);
  const stub = stubFetch({ ok: true, result: { version_id: 'v1', status: 'ARTIFACT_BYTES_MISSING', object_key: 'k' } });
  try {
    const out = await new CustodyToolHandler().handleReportMissing({ version_id: 'v1' });
    assertEquals(sentOp(stub.calls[0].init).op, 'report_missing');
    assertEquals(JSON.parse(out.content[0].text).status, 'ARTIFACT_BYTES_MISSING');
  } finally {
    stub.restore();
    clearKeys();
  }
});

Deno.test('every S252 handler rejects missing required arguments before any network call', async () => {
  clearKeys();
  Deno.env.set(CUSTODY_KEY_ENV, FAKE_KEY);
  const h = new CustodyToolHandler();
  await assertRejects(() => h.handleStore({}), Error, 'is required for custody_store');
  await assertRejects(() => h.handleBeginUpload({}), Error, 'is required for custody_begin_upload');
  await assertRejects(() => h.handleFinalizeUpload({}), Error, 'upload_id is required');
  await assertRejects(() => h.handleSetAlias({}), Error, 'is required for custody_set_alias');
  await assertRejects(() => h.handleListVersions({}), Error, 'is required for custody_list_versions');
  await assertRejects(() => h.handleAddDependency({}), Error, 'is required for custody_add_dependency');
  await assertRejects(() => h.handleDependencyClosure({}), Error, 'root_version_id is required');
  await assertRejects(() => h.handleExportSession({}), Error, 'root_version_id is required');
  await assertRejects(() => h.handleScanArchive({}), Error, 'version_id is required');
  await assertRejects(() => h.handleReportMissing({}), Error, 'version_id is required');
  clearKeys();
});
