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
    result: { id: 'v1', sha256: 'abc', byte_length: 10, custody_state: 'CUSTODIED' },
  });
  try {
    const out = await new CustodyToolHandler().handleGetMetadata({ version_id: 'v1' });
    const parsed = JSON.parse(out.content[0].text);
    assertEquals(parsed.version_id, 'v1');
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
