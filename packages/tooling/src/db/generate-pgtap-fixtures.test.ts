import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generatePgtapRegistrySql, loadPgtapRegistryRows } from './generate-pgtap-fixtures.js';

const temporaryRoots: string[] = [];

function createRegistry(files: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'base-app-pgtap-registry-'));
  temporaryRoots.push(root);
  for (const [relativePath, data] of Object.entries(files)) {
    const path = join(root, 'supabase', 'tests', relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data), 'utf8');
  }
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('generatePgtapRegistrySql', () => {
  it('merges the base group membership with sorted extension declarations', () => {
    const root = createRegistry({
      'grants-allowlist.json': { anon: [], authenticated: [] },
      'expected-group-members.json': { audit_writer: ['app_config_admin'] },
      'expected-group-members.d/01-extra.json': { audit_writer: ['billing_system'] },
      'auth-fn-registry.d/identity.json': {
        functions: [
          {
            name: 'before_user_created',
            signature: '(jsonb)',
            reason: 'Enforces the signup ceiling.',
          },
        ],
      },
    });

    const first = generatePgtapRegistrySql(root);
    const second = generatePgtapRegistrySql(root);
    expect(first).toBe(second);
    expect(first).toContain("('audit_writer', 'app_config_admin')");
    expect(first).toContain("('audit_writer', 'billing_system')");
    expect(first).toContain(
      "('identity', 'before_user_created', '(jsonb)', 'Enforces the signup ceiling.')",
    );
    expect(first).toContain(
      'revoke all on schema test_support from public, anon, authenticated, api_runtime;',
    );
  });

  it('emits role-scoped grant rows and safely SQL-quotes registry text', () => {
    const root = createRegistry({
      'grants-allowlist.json': {
        anon: [],
        authenticated: [{ schema: 'audit', table: 'events', privileges: ['INSERT', 'SELECT'] }],
      },
      'expected-group-members.json': { audit_writer: [] },
      'auth-fn-registry.d/identity.json': {
        functions: [
          { name: 'hook', signature: '(jsonb)', reason: "Operator's fixed hook; no PII." },
        ],
      },
    });

    const sql = generatePgtapRegistrySql(root);
    expect(sql).toContain(
      "('authenticated', 'audit', 'events', ARRAY['INSERT', 'SELECT']::text[])",
    );
    expect(sql).toContain("'Operator''s fixed hook; no PII.'");
  });

  it('rejects unsafe database object names instead of interpolating them', () => {
    const root = createRegistry({
      'grants-allowlist.json': {
        anon: [],
        authenticated: [
          { schema: 'audit', table: "events'); drop schema public; --", privileges: ['INSERT'] },
        ],
      },
      'expected-group-members.json': { audit_writer: [] },
    });

    expect(() => loadPgtapRegistryRows(root)).toThrow(/Invalid registry shape/);
  });

  it('rejects undeclared extension groups and duplicate members', () => {
    const unknownGroupRoot = createRegistry({
      'grants-allowlist.json': { anon: [], authenticated: [] },
      'expected-group-members.json': { audit_writer: [] },
      'expected-group-members.d/extension.json': { made_up_writer: ['billing_system'] },
    });
    expect(() => loadPgtapRegistryRows(unknownGroupRoot)).toThrow(/Undeclared role group/);

    const duplicateMemberRoot = createRegistry({
      'grants-allowlist.json': { anon: [], authenticated: [] },
      'expected-group-members.json': { audit_writer: ['billing_system'] },
      'expected-group-members.d/extension.json': { audit_writer: ['billing_system'] },
    });
    expect(() => loadPgtapRegistryRows(duplicateMemberRoot)).toThrow(/Duplicate group member/);
  });

  it('rejects extra public grant roles and repeated auth function signatures', () => {
    const unknownRoleRoot = createRegistry({
      'grants-allowlist.json': { anon: [], authenticated: [], api_runtime: [] },
      'expected-group-members.json': { audit_writer: [] },
    });
    expect(() => loadPgtapRegistryRows(unknownRoleRoot)).toThrow(/Invalid registry shape/);

    const duplicateAuthRoot = createRegistry({
      'grants-allowlist.json': { anon: [], authenticated: [] },
      'expected-group-members.json': { audit_writer: [] },
      'auth-fn-registry.d/identity.json': {
        functions: [
          { name: 'hook', signature: '(jsonb)', reason: 'First declared reason.' },
          { name: 'hook', signature: '(jsonb)', reason: 'Duplicate declared reason.' },
        ],
      },
    });
    expect(() => loadPgtapRegistryRows(duplicateAuthRoot)).toThrow(
      /Duplicate registry entry: auth function signature/,
    );
  });
});
