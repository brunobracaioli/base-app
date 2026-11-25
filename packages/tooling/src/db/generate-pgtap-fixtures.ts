import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
  parseCoreAuthFunctionRegistryDocument,
  type CoreAuthFunctionRegistryEntry,
} from './core-auth-function-registry.ts';

const identifier = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const privilege = z.enum([
  'DELETE',
  'INSERT',
  'REFERENCES',
  'SELECT',
  'TRIGGER',
  'TRUNCATE',
  'UPDATE',
]);

const grantEntry = z
  .object({
    schema: identifier,
    table: identifier,
    privileges: z.array(privilege).min(1),
  })
  .strict();

const grantsFile = z
  .object({
    anon: z.array(grantEntry),
    authenticated: z.array(grantEntry),
  })
  .strict();

const groupName = identifier;
const groupMembersFile = z.record(groupName, z.array(identifier));

type GrantRow = {
  roleName: 'anon' | 'authenticated';
  schemaName: string;
  objectName: string;
  privileges: string[];
};

type GroupMemberRow = {
  groupName: string;
  memberName: string;
};

type CoreAuthFunctionRow = {
  schemaName: string;
  functionName: string;
  signature: string;
  migration: string;
  ownerName: string;
  executeCallers: string[];
  purpose: string;
};

export type PgtapRegistryRows = {
  grants: GrantRow[];
  groupMembers: GroupMemberRow[];
  coreAuthFunctions: CoreAuthFunctionRow[];
};

function parseFile<T>(path: string, schema: z.ZodType<T>): T {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    throw new Error(`Invalid JSON registry file: ${path}`);
  }

  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Invalid registry shape in ${path}${paths ? `: ${paths}` : ''}`);
  }
  return parsed.data;
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Duplicate registry entry: ${label}`);
    seen.add(value);
  }
}

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlTextArray(values: readonly string[]): string {
  return `ARRAY[${values.map(sqlText).join(', ')}]::text[]`;
}

function findRepositoryRoot(start: string): string {
  let current = resolve(start);
  for (;;) {
    if (
      existsSync(resolve(current, 'supabase/tests')) &&
      existsSync(resolve(current, 'packages/tooling'))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) throw new Error('Could not find the base-app repository root.');
    current = parent;
  }
}

function readRegularJsonFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      if (entry.isSymbolicLink()) throw new Error(`Registry symlink is not allowed: ${entry.name}`);
      if (entry.isDirectory()) return null;
      if (!entry.isFile() || !entry.name.endsWith('.json')) return null;
      return resolve(directory, entry.name);
    })
    .filter((path): path is string => path !== null);
}

function readCoreAuthFunctionRegistry(path: string): CoreAuthFunctionRow[] {
  if (!lstatSync(path).isFile())
    throw new Error(`Core Auth-function registry must be a regular file: ${path}`);
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    throw new Error(`Invalid JSON registry file: ${path}`);
  }
  let registry: CoreAuthFunctionRegistryEntry[];
  try {
    registry = parseCoreAuthFunctionRegistryDocument(document);
  } catch (error) {
    throw new Error(
      `Invalid core Auth-function registry in ${path}: ${error instanceof Error ? error.message : 'unknown validation error'}`,
      { cause: error },
    );
  }
  const rows: CoreAuthFunctionRow[] = [];
  for (const fn of registry) {
    const signature = fn.signature.replaceAll(' ', '');
    rows.push({
      schemaName: fn.schema,
      functionName: fn.name,
      signature,
      migration: fn.migration,
      ownerName: fn.owner,
      executeCallers: [...fn.executeCallers],
      purpose: fn.purpose,
    });
  }
  assertUnique(
    rows.map((fn) => `${fn.schemaName}.${fn.functionName}${fn.signature}`),
    'core Auth function signature',
  );
  return rows.sort((left, right) =>
    `${left.schemaName}.${left.functionName}${left.signature}`.localeCompare(
      `${right.schemaName}.${right.functionName}${right.signature}`,
    ),
  );
}

export function loadPgtapRegistryRows(root: string): PgtapRegistryRows {
  const testDir = resolve(root, 'supabase/tests');
  const grantPath = resolve(testDir, 'grants-allowlist.json');
  const grantsByRole = parseFile(grantPath, grantsFile);
  const grants: GrantRow[] = [];
  for (const roleName of ['anon', 'authenticated'] as const) {
    for (const entry of grantsByRole[roleName]) {
      assertUnique(entry.privileges, `${roleName}.${entry.schema}.${entry.table} privilege`);
      grants.push({
        roleName,
        schemaName: entry.schema,
        objectName: entry.table,
        privileges: [...entry.privileges].sort(),
      });
    }
  }
  assertUnique(
    grants.map((row) => `${row.roleName}.${row.schemaName}.${row.objectName}`),
    'role/schema/table grant row',
  );

  const groupPath = resolve(testDir, 'expected-group-members.json');
  const baseGroups = parseFile(groupPath, groupMembersFile);
  const groups = new Map<string, Set<string>>();
  for (const [group, members] of Object.entries(baseGroups)) {
    assertUnique(members, `${group} base member`);
    groups.set(group, new Set(members));
  }
  for (const path of readRegularJsonFiles(resolve(testDir, 'expected-group-members.d'))) {
    const additions = parseFile(path, groupMembersFile);
    for (const [group, members] of Object.entries(additions)) {
      assertUnique(members, `${group} extension member`);
      const existing = groups.get(group);
      if (!existing) throw new Error(`Undeclared role group in ${path}: ${group}`);
      for (const member of members) {
        if (existing.has(member)) throw new Error(`Duplicate group member: ${group}.${member}`);
        existing.add(member);
      }
    }
  }
  const groupMembers: GroupMemberRow[] = [...groups.entries()]
    .flatMap(([groupName, members]) =>
      [...members].sort().map((memberName) => ({ groupName, memberName })),
    )
    .sort((left, right) =>
      `${left.groupName}.${left.memberName}`.localeCompare(
        `${right.groupName}.${right.memberName}`,
      ),
    );

  if (existsSync(resolve(testDir, 'auth-fn-registry.d')))
    throw new Error('supabase/tests/auth-fn-registry.d is no longer supported.');
  const coreAuthFunctions = readCoreAuthFunctionRegistry(
    resolve(testDir, 'core-auth-fn-registry.json'),
  );

  return { grants, groupMembers, coreAuthFunctions };
}

export function generatePgtapRegistrySql(root: string): string {
  const rows = loadPgtapRegistryRows(root);
  const statements = [
    'begin;',
    'drop schema if exists test_support cascade;',
    'create schema test_support;',
    `create table test_support.expected_grants (
  role_name text not null check (role_name in ('anon', 'authenticated')),
  schema_name text not null,
  object_name text not null,
  privileges text[] not null,
  primary key (role_name, schema_name, object_name)
);`,
    `create table test_support.expected_group_members (
  group_name text not null,
  member_name text not null,
  primary key (group_name, member_name)
);`,
    `create table test_support.expected_core_auth_fn_registry (
  schema_name text not null,
  function_name text not null,
  signature text not null,
  migration text not null,
  owner_name text not null check (owner_name = 'postgres'),
  execute_callers text[] not null,
  purpose text not null,
  primary key (schema_name, function_name, signature)
);`,
  ];

  if (rows.grants.length > 0) {
    statements.push(
      `insert into test_support.expected_grants (role_name, schema_name, object_name, privileges) values\n${rows.grants
        .map(
          (row) =>
            `  (${sqlText(row.roleName)}, ${sqlText(row.schemaName)}, ${sqlText(row.objectName)}, ${sqlTextArray(row.privileges)})`,
        )
        .join(',\n')};`,
    );
  }
  if (rows.groupMembers.length > 0) {
    statements.push(
      `insert into test_support.expected_group_members (group_name, member_name) values\n${rows.groupMembers
        .map((row) => `  (${sqlText(row.groupName)}, ${sqlText(row.memberName)})`)
        .join(',\n')};`,
    );
  }
  if (rows.coreAuthFunctions.length > 0) {
    statements.push(
      `insert into test_support.expected_core_auth_fn_registry (schema_name, function_name, signature, migration, owner_name, execute_callers, purpose) values\n${rows.coreAuthFunctions
        .map(
          (fn) =>
            `  (${sqlText(fn.schemaName)}, ${sqlText(fn.functionName)}, ${sqlText(fn.signature)}, ${sqlText(fn.migration)}, ${sqlText(fn.ownerName)}, ${sqlTextArray(fn.executeCallers)}, ${sqlText(fn.purpose)})`,
        )
        .join(',\n')};`,
    );
  }

  statements.push(
    'revoke all on schema test_support from public, anon, authenticated, api_runtime;',
    'revoke all on all tables in schema test_support from public, anon, authenticated, api_runtime;',
    'commit;',
  );
  return `${statements.join('\n\n')}\n`;
}

function main(): void {
  const root = findRepositoryRoot(process.cwd());
  const output = resolve(root, 'supabase/.temp/expected-registry.sql');
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, generatePgtapRegistrySql(root), { encoding: 'utf8', mode: 0o600 });
  const rows = loadPgtapRegistryRows(root);
  process.stdout.write(
    JSON.stringify({
      output: 'supabase/.temp/expected-registry.sql',
      grants: rows.grants.length,
      groupMembers: rows.groupMembers.length,
      coreAuthFunctions: rows.coreAuthFunctions.length,
    }) + '\n',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
