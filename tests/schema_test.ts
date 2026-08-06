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

// The 13 tools that follow the original 12, in advertised order: record
// retrieval, the 4 read-only custody tools (S251), then the 8 governed custody
// tools (S252).
const POST_MEMORY_13 = [
  'get_record_by_id',
  'custody_resolve_alias',
  'custody_get_metadata',
  'custody_retrieve',
  'custody_verify',
  'custody_store',
  'custody_set_alias',
  'custody_list_versions',
  'custody_add_dependency',
  'custody_dependency_closure',
  'custody_export_session',
  'custody_scan_archive',
  'custody_report_missing',
];

// Of the post-memory tools, these are read-only; the rest perform governed
// writes and must NOT advertise readOnlyHint: true.
const READ_ONLY_TOOLS = new Set([
  'get_record_by_id',
  'custody_resolve_alias',
  'custody_get_metadata',
  'custody_retrieve',
  'custody_verify',
  'custody_list_versions',
  'custody_dependency_closure',
  'custody_report_missing',
]);

Deno.test('the original 12 memory tools are still exactly 12', () => {
  assertEquals(MEMORY_TOOLS_SCHEMA.length, 12);
  assertEquals(MEMORY_TOOLS_SCHEMA.map((t: any) => t.name), ORIGINAL_12);
});

Deno.test('total advertised tool count is 25', () => {
  assertEquals(ALL_TOOLS_SCHEMA.length, 25);
  assertEquals(MEMORY_TOOLS_SCHEMA.length + RECORD_TOOLS_SCHEMA.length + CUSTODY_TOOLS_SCHEMA.length, 25);
  assertEquals(CUSTODY_TOOLS_SCHEMA.length, 12);
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

Deno.test('the 13 non-memory tools are present, after the original 12, in order', () => {
  assertEquals(ALL_TOOLS_SCHEMA.slice(12).map((t: any) => t.name), POST_MEMORY_13);
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

Deno.test('read tools are read-only and governed-write tools are not', () => {
  // The read tools must advertise readOnlyHint: true so clients do not prompt;
  // the governed-write tools (store, set_alias, add_dependency, export_session,
  // scan_archive) must NOT claim to be read-only.
  for (const t of ALL_TOOLS_SCHEMA.slice(12) as any[]) {
    if (READ_ONLY_TOOLS.has(t.name)) {
      assertEquals(t.annotations?.readOnlyHint, true, `${t.name} should be readOnlyHint: true`);
    } else {
      assert(
        t.annotations?.readOnlyHint !== true,
        `${t.name} is a write tool but advertises readOnlyHint: true`,
      );
    }
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
