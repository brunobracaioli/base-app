import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generatePgtapRegistrySql, loadPgtapRegistryRows } from './generate-pgtap-fixtures.js';

const temporaryRoots: string[] = [];
const migration = '20261125120000_core_auth_helpers.sql';
const w4Migration = '20261125210517_w4_identity_profile_consents_fresh_roles.sql';
const w6Migration = '20261127015300_w6_email_auth_safety.sql';

const coreAuthFunctions = [
  {
    schema: 'identity',
    name: 'before_user_created',
    signature: '(jsonb)',
    migration,
    owner: 'postgres',
    executeCallers: ['supabase_auth_admin'],
    purpose: 'Enforces the signup ceiling.',
  },
  {
    schema: 'identity',
    name: 'count_unconfirmed_users',
    signature: '()',
    migration,
    owner: 'postgres',
    executeCallers: ['ops'],
    purpose: 'Returns only a bounded count.',
  },
  {
    schema: 'identity',
    name: 'clear_unverified_password',
    signature: '()',
    migration: w6Migration,
    owner: 'postgres',
    executeCallers: ['supabase_auth_admin'],
    purpose: 'Clears a password set before email ownership is proven.',
  },
  {
    schema: 'identity',
    name: 'delete_unconfirmed_users',
    signature: '()',
    migration,
    owner: 'postgres',
    executeCallers: ['ops'],
    purpose: 'Deletes only a bounded batch.',
  },
  {
    schema: 'identity',
    name: 'read_fresh_roles',
    signature: '(uuid)',
    migration: w4Migration,
    owner: 'postgres',
    executeCallers: ['authenticated'],
    purpose: "Returns only the calling user's current role metadata.",
  },
];

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

function commonFiles(): Record<string, unknown> {
  return {
    'grants-allowlist.json': { anon: [], authenticated: [] },
    'expected-group-members.json': { audit_writer: [] },
    'core-auth-fn-registry.json': { functions: coreAuthFunctions },
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('generatePgtapRegistrySql', () => {
  it('merges group membership and emits the fixed core Auth registry deterministically', () => {
    const root = createRegistry({
      ...commonFiles(),
      'expected-group-members.json': { audit_writer: ['app_config_admin'] },
      'expected-group-members.d/01-extra.json': { audit_writer: ['billing_system'] },
    });

    const first = generatePgtapRegistrySql(root);
    const second = generatePgtapRegistrySql(root);
    expect(first).toBe(second);
    expect(first).toContain("('audit_writer', 'app_config_admin')");
    expect(first).toContain("('audit_writer', 'billing_system')");
    expect(first).toContain('create table test_support.expected_core_auth_fn_registry');
    expect(first).toContain(
      `('identity', 'before_user_created', '(jsonb)', '${migration}', 'postgres', ARRAY['supabase_auth_admin']::text[], 'Enforces the signup ceiling.')`,
    );
    expect(first).toContain(
      `('identity', 'clear_unverified_password', '()', '${w6Migration}', 'postgres', ARRAY['supabase_auth_admin']::text[], 'Clears a password set before email ownership is proven.')`,
    );
    expect(first).toContain(
      'revoke all on schema test_support from public, anon, authenticated, api_runtime;',
    );
  });

  it('emits role-scoped grants and safely SQL-quotes registry purpose text', () => {
    const functions = coreAuthFunctions.map((fn) =>
      fn.name === 'before_user_created' ? { ...fn, purpose: "Operator's fixed hook; no PII." } : fn,
    );
    const root = createRegistry({
      ...commonFiles(),
      'grants-allowlist.json': {
        anon: [],
        authenticated: [{ schema: 'audit', table: 'events', privileges: ['INSERT', 'SELECT'] }],
      },
      'core-auth-fn-registry.json': { functions },
    });

    const sql = generatePgtapRegistrySql(root);
    expect(sql).toContain(
      "('authenticated', 'audit', 'events', ARRAY['INSERT', 'SELECT']::text[])",
    );
    expect(sql).toContain("'Operator''s fixed hook; no PII.'");
  });

  it('rejects unsafe database object names instead of interpolating them', () => {
    const root = createRegistry({
      ...commonFiles(),
      'grants-allowlist.json': {
        anon: [],
        authenticated: [
          { schema: 'audit', table: "events'); drop schema public; --", privileges: ['INSERT'] },
        ],
      },
    });

    expect(() => loadPgtapRegistryRows(root)).toThrow(/Invalid registry shape/);
  });

  it('rejects undeclared extension groups and duplicate members', () => {
    const unknownGroupRoot = createRegistry({
      ...commonFiles(),
      'expected-group-members.d/extension.json': { made_up_writer: ['billing_system'] },
    });
    expect(() => loadPgtapRegistryRows(unknownGroupRoot)).toThrow(/Undeclared role group/);

    const duplicateMemberRoot = createRegistry({
      ...commonFiles(),
      'expected-group-members.json': { audit_writer: ['billing_system'] },
      'expected-group-members.d/extension.json': { audit_writer: ['billing_system'] },
    });
    expect(() => loadPgtapRegistryRows(duplicateMemberRoot)).toThrow(/Duplicate group member/);
  });

  it('rejects extra grant roles, duplicate core entries, unapproved functions, and expanded callers', () => {
    const unknownRoleRoot = createRegistry({
      ...commonFiles(),
      'grants-allowlist.json': { anon: [], authenticated: [], api_runtime: [] },
    });
    expect(() => loadPgtapRegistryRows(unknownRoleRoot)).toThrow(/Invalid registry shape/);

    const duplicateRoot = createRegistry({
      ...commonFiles(),
      'core-auth-fn-registry.json': {
        functions: [coreAuthFunctions[0], coreAuthFunctions[0], ...coreAuthFunctions.slice(1)],
      },
    });
    expect(() => loadPgtapRegistryRows(duplicateRoot)).toThrow(
      /Duplicate core Auth-function registry entry/,
    );

    const extraFunctionRoot = createRegistry({
      ...commonFiles(),
      'core-auth-fn-registry.json': {
        functions: [
          ...coreAuthFunctions,
          {
            schema: 'identity',
            name: 'arbitrary_auth_helper',
            signature: '()',
            migration,
            owner: 'postgres',
            executeCallers: ['ops'],
            purpose: 'Extra helper.',
          },
        ],
      },
    });
    expect(() => loadPgtapRegistryRows(extraFunctionRoot)).toThrow(/not allowlisted/);

    const callerRoot = createRegistry({
      ...commonFiles(),
      'core-auth-fn-registry.json': {
        functions: coreAuthFunctions.map((fn) =>
          fn.name === 'before_user_created'
            ? { ...fn, executeCallers: ['supabase_auth_admin', 'authenticated'] }
            : fn,
        ),
      },
    });
    expect(() => loadPgtapRegistryRows(callerRoot)).toThrow(
      /callers do not match the fixed policy/,
    );

    const expandedFreshRoleCallersRoot = createRegistry({
      ...commonFiles(),
      'core-auth-fn-registry.json': {
        functions: coreAuthFunctions.map((fn) =>
          fn.name === 'read_fresh_roles' ? { ...fn, executeCallers: ['authenticated', 'ops'] } : fn,
        ),
      },
    });
    expect(() => loadPgtapRegistryRows(expandedFreshRoleCallersRoot)).toThrow(
      /callers do not match the fixed policy/,
    );
  });

  it('rejects an incomplete or extension-migration core Auth registry', () => {
    const incompleteRoot = createRegistry({
      ...commonFiles(),
      'core-auth-fn-registry.json': { functions: coreAuthFunctions.slice(0, 2) },
    });
    expect(() => loadPgtapRegistryRows(incompleteRoot)).toThrow(/complete fixed core function set/);

    const extensionMigrationRoot = createRegistry({
      ...commonFiles(),
      'core-auth-fn-registry.json': {
        functions: coreAuthFunctions.map((fn) => ({
          ...fn,
          migration: '20261125120000_ext-x_helper.sql',
        })),
      },
    });
    expect(() => loadPgtapRegistryRows(extensionMigrationRoot)).toThrow(/must be a core migration/);
  });

  it('rejects the removed extension auth-function registry directory', () => {
    const root = createRegistry({
      ...commonFiles(),
      'auth-fn-registry.d/x.json': {
        functions: [
          { name: 'arbitrary', signature: '()', reason: 'Legacy extension owner override.' },
        ],
      },
    });
    expect(() => loadPgtapRegistryRows(root)).toThrow(/auth-fn-registry.d is no longer supported/);
  });
});
