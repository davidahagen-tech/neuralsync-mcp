// Schema tests — the advertised tool surface.
//
// The central guarantee this file enforces: the original twelve tools are
// untouched. Not "look unchanged" — deep-equal to MEMORY_TOOLS_SCHEMA, in the
// same order, at the same indexes.
//
// Run: deno test --allow-env tests/schema_test.ts

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import {
  ALL_TOOLS_SCHEMA,
  MEMORY_TOOLS_SCHEMA,
  RECORD_TOOLS_SCHEMA,
} from '../memory-tools.ts';
import { CUSTODY_TOOLS_SCHEMA } from '../custody-tools.ts';

const ORIGINAL_12 = [
  'memory_read',
  'memory_write',
  'memory_search',
  'memory_stats',
  'memory_recall',
  'memory_get_recent',
  'memory_get_latest_session',
  'memory_get_by_session',
  'memory_filter',
  'memory_current_session',
  'search',
  'fetch',
];

const NEW_5 = [
  'get_record_by_id',
  'custody_resolve_alias',
  'custody_get_metadata',
  'custody_retrieve',
  'custody_verify',
];

Deno.test('the original 12 memory tools are still exactly 12', () => {
  assertEquals(MEMORY_TOOLS_SCHEMA.length, 12);
  assertEquals(MEMORY_TOOLS_SCHEMA.map((t: any) => t.name), ORIGINAL_12);
});

Deno.test('total advertised tool count is 17', () => {
  assertEquals(ALL_TOOLS_SCHEMA.length, 17);
  assertEquals(MEMORY_TOOLS_SCHEMA.length + RECORD_TOOLS_SCHEMA.length + CUSTODY_TOOLS_SCHEMA.length, 17);
});

Deno.test('original 12 occupy the first 12 slots and are deep-equal, unmodified', () => {
  for (let i = 0; i < 12; i++) {
    assertEquals(
      JSON.stringify(ALL_TOOLS_SCHEMA[i]),
      JSON.stringify(MEMORY_TOOLS_SCHEMA[i]),
      `tool at index ${i} (${ORIGINAL_12[i]}) was modified`,
    );
  }
});

Deno.test('the 5 new tools are present, after the original 12', () => {
  assertEquals(ALL_TOOLS_SCHEMA.slice(12).map((t: any) => t.name), NEW_5);
});

Deno.test('no duplicate tool names', () => {
  const names = ALL_TOOLS_SCHEMA.map((t: any) => t.name);
  assertEquals(new Set(names).size, names.length);
});

Deno.test('every tool declares name, description and an object inputSchema', () => {
  for (const t of ALL_TOOLS_SCHEMA as any[]) {
    assert(typeof t.name === 'string' && t.name.length > 0, `bad name: ${t.name}`);
    assert(typeof t.description === 'string' && t.description.length > 10, `bad description on ${t.name}`);
    assert(t.inputSchema?.type === 'object', `bad inputSchema on ${t.name}`);
  }
});

Deno.test('no property declares `required: true` (rejected by strict validators)', () => {
  // Documented in memory-tools.ts: required fields belong in the parent
  // `required: [...]` array. A property-level `required: true` is silently
  // rejected by ChatGPT's validator.
  for (const t of ALL_TOOLS_SCHEMA as any[]) {
    const props = t.inputSchema?.properties ?? {};
    for (const [key, def] of Object.entries<any>(props)) {
      assert(def?.required !== true, `${t.name}.${key} uses property-level required: true`);
    }
    if (t.inputSchema.required !== undefined) {
      assert(Array.isArray(t.inputSchema.required), `${t.name}.required must be an array`);
    }
  }
});

Deno.test('new tools name every required param in their properties', () => {
  for (const t of ALL_TOOLS_SCHEMA.slice(12) as any[]) {
    for (const r of t.inputSchema.required ?? []) {
      assert(
        Object.prototype.hasOwnProperty.call(t.inputSchema.properties, r),
        `${t.name} requires "${r}" but does not declare it`,
      );
    }
  }
});

Deno.test('all 5 new tools are marked read-only', () => {
  // Nothing added here can write, store, delete or supersede an artifact.
  for (const t of ALL_TOOLS_SCHEMA.slice(12) as any[]) {
    assertEquals(t.annotations?.readOnlyHint, true, `${t.name} is not readOnlyHint: true`);
  }
});

Deno.test('custody tools never advertise a credential parameter', () => {
  const forbidden = ['key', 'custody_key', 'api_key', 'token', 'secret', 'password', 'authorization'];
  for (const t of CUSTODY_TOOLS_SCHEMA as any[]) {
    for (const key of Object.keys(t.inputSchema.properties ?? {})) {
      assert(
        !forbidden.includes(key.toLowerCase()),
        `${t.name} exposes a credential-shaped parameter: ${key}`,
      );
    }
  }
});
