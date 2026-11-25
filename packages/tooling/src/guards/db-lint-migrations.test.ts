import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  lintCoreAuthFunctionMigrations,
  lintExtensionMigration,
  lintExtensionMigrations,
  MigrationLintError,
  parseCoreAuthFunctionRegistry,
  parseExpectedGroupMemberDocuments,
  resolveDerivedRepositoryMode,
  validateDerivedMigrationNames,
} from './db-lint-migrations.js';

const migrationName = '20261124120000_ext-x_guard.sql';
const coreAuthMigrationName = '20261125120000_core_auth_helpers.sql';
const w4CoreAuthMigrationName = '20261125210517_w4_identity_profile_consents_fresh_roles.sql';

const coreAuthFunctions = [
  {
    schema: 'identity',
    name: 'before_user_created',
    signature: '(jsonb)',
    migration: coreAuthMigrationName,
    owner: 'postgres',
    executeCallers: ['supabase_auth_admin'],
    purpose: 'Enforces the fixed signup ceiling before Auth creates a user.',
  },
  {
    schema: 'identity',
    name: 'count_unconfirmed_users',
    signature: '()',
    migration: coreAuthMigrationName,
    owner: 'postgres',
    executeCallers: ['ops'],
    purpose: 'Returns only the bounded unconfirmed-account count to maintenance.',
  },
  {
    schema: 'identity',
    name: 'delete_unconfirmed_users',
    signature: '()',
    migration: coreAuthMigrationName,
    owner: 'postgres',
    executeCallers: ['ops'],
    purpose: 'Deletes only the fixed-age bounded batch of unconfirmed accounts.',
  },
  {
    schema: 'identity',
    name: 'read_fresh_roles',
    signature: '(uuid)',
    migration: w4CoreAuthMigrationName,
    owner: 'postgres',
    executeCallers: ['authenticated'],
    purpose: "Returns only the caller's current raw role metadata.",
  },
] as const;

const coreAuthMigration = `
  CREATE OR REPLACE FUNCTION identity.before_user_created(p_event jsonb) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$ BEGIN RETURN p_event; END; $$;
  ALTER FUNCTION identity.before_user_created(jsonb) OWNER TO postgres;
  CREATE OR REPLACE FUNCTION identity.count_unconfirmed_users() RETURNS bigint
  LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT 0::bigint; $$;
  ALTER FUNCTION identity.count_unconfirmed_users() OWNER TO postgres;
  CREATE OR REPLACE FUNCTION identity.delete_unconfirmed_users() RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$ BEGIN RETURN 0; END; $$;
  ALTER FUNCTION identity.delete_unconfirmed_users() OWNER TO postgres;
`;

const w4CoreAuthMigration = `
  CREATE FUNCTION identity.read_fresh_roles(p_user_id uuid)
  RETURNS TABLE (roles jsonb)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$ BEGIN RETURN; END; $$;
  ALTER FUNCTION identity.read_fresh_roles(uuid) OWNER TO postgres;
`;

const coreAuthMigrations = [
  { name: coreAuthMigrationName, contents: coreAuthMigration },
  { name: w4CoreAuthMigrationName, contents: w4CoreAuthMigration },
];

function lint(contents: string, options: Parameters<typeof lintExtensionMigration>[1] = {}) {
  return lintExtensionMigration({ name: migrationName, contents }, options);
}

describe('PostgreSQL AST policy for extension migrations', () => {
  it.each([
    ['CREATE TABLE', 'CREATE TABLE audit.x (id uuid PRIMARY KEY);'],
    ['GRANT', 'GRANT SELECT ON identity.profiles TO x_system;'],
    [
      'CREATE POLICY',
      'CREATE POLICY x_policy ON audit.events FOR SELECT TO x_system USING (true);',
    ],
    [
      'CREATE TRIGGER',
      'CREATE TRIGGER x_trigger AFTER INSERT ON auth.users EXECUTE FUNCTION x.handle();',
    ],
  ])('rejects %s that targets a protected core schema', async (_label, sql) => {
    const result = await lint(sql);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.code).toMatch(/core/);
  });

  it('uses PostgreSQL parsing so SQL-looking comments and strings do not trigger false positives', async () => {
    const result = await lint(`
      CREATE TABLE x.notes (body text NOT NULL);
      INSERT INTO x.notes (body) VALUES ('CREATE TABLE audit.fake (id uuid); -- CREATE TRIGGER');
      -- GRANT SELECT ON identity.profiles TO x_system;
    `);
    expect(result.issues).toEqual([]);
  });

  it('rejects unsupported procedural SQL instead of scanning it with regexes', async () => {
    const result = await lint("DO $$ BEGIN EXECUTE 'CREATE TABLE audit.hidden (id uuid)'; END $$;");
    expect(result.issues[0]?.code).toBe('unsupported-procedural-statement');
    expect(result.issues[0]?.message).not.toContain('audit.hidden');
  });

  it('rejects malformed PostgreSQL with a source-safe parse diagnostic', async () => {
    const result = await lint(
      'CREATE TABLE x.safe (id uuid); CREATE TABLE audit.SENSITIVE_TEST_MARKER (',
    );
    expect(result.issues[0]?.code).toBe('sql-parse');
    expect(result.issues[0]?.message).not.toContain('SENSITIVE_TEST_MARKER');
  });

  it('allows the exact audit role grant to the extension system role', async () => {
    const result = await lint('GRANT audit_writer TO x_system;');
    expect(result.issues).toEqual([]);
  });

  it.each(['GRANT x_system TO postgres;', 'GRANT audit_writer TO postgres;'])(
    'rejects extension role grants that try to assume postgres: %s',
    async (sql) => {
      const result = await lint(sql);
      expect(result.issues.some((issue) => issue.code === 'core-role-grant')).toBe(true);
    },
  );

  it('requires an expected-group-members declaration for auxiliary role grants', async () => {
    const sql = 'GRANT audit_writer TO x_admin_grantor;';
    const rejected = await lint(sql);
    expect(rejected.issues[0]?.code).toBe('core-role-grant');

    const accepted = await lint(sql, {
      registeredGroupRoles: new Map([['audit_writer', new Set(['x_admin_grantor'])]]),
    });
    expect(accepted.issues).toEqual([]);

    const wrongPair = await lint(sql, {
      registeredGroupRoles: new Map([['audit_reader', new Set(['x_admin_grantor'])]]),
    });
    expect(wrongPair.issues[0]?.code).toBe('core-role-grant');
  });

  it('requires extension roles to be NOLOGIN and rejects elevated PostgreSQL role attributes', async () => {
    const safe = await lint('CREATE ROLE x_system NOLOGIN;');
    expect(safe.issues).toEqual([]);

    for (const sql of [
      'CREATE ROLE x_system LOGIN;',
      'CREATE ROLE x_system NOLOGIN SUPERUSER;',
      'CREATE ROLE x_system NOLOGIN CREATEDB;',
      'CREATE ROLE x_system NOLOGIN CREATEROLE;',
      'CREATE ROLE x_system NOLOGIN REPLICATION;',
      'CREATE ROLE x_system NOLOGIN BYPASSRLS;',
      'ALTER ROLE x_system SUPERUSER;',
      'ALTER ROLE x_system NOLOGIN BYPASSRLS;',
    ]) {
      const result = await lint(sql);
      expect(result.issues.some((issue) => issue.code === 'role-privilege')).toBe(true);
    }
  });

  it('allows only INSERT on the explicitly extensible app-config table', async () => {
    const allowed = await lint(
      "INSERT INTO app_config.operator_alert_exempt_keys (key) VALUES ('billing.delayed');",
    );
    expect(allowed.issues).toEqual([]);

    const deniedUpdate = await lint(
      "UPDATE app_config.operator_alert_exempt_keys SET key = 'billing.delayed';",
    );
    expect(deniedUpdate.issues[0]?.code).toBe('core-data-mutation');

    const deniedUpsert = await lint(
      "INSERT INTO app_config.operator_alert_exempt_keys (key) VALUES ('billing.delayed') ON CONFLICT (key) DO UPDATE SET key = EXCLUDED.key;",
    );
    expect(deniedUpsert.issues[0]?.code).toBe('core-data-mutation');
  });

  it('allows a 1:1 auth.users foreign key in an extension-owned table', async () => {
    const result = await lint(
      'CREATE TABLE x.user_profile (user_id uuid PRIMARY KEY REFERENCES auth.users(id), display_name text);',
    );
    expect(result.issues).toEqual([]);
  });

  it('proves the auth.users 1:1 key for ALTER TABLE additions', async () => {
    const valid = await lint(
      'CREATE TABLE x.user_profile (user_id uuid PRIMARY KEY); ALTER TABLE x.user_profile ADD CONSTRAINT user_ref FOREIGN KEY (user_id) REFERENCES auth.users(id);',
    );
    expect(valid.issues).toEqual([]);

    const manyToOne = await lint(
      'CREATE TABLE x.user_profile (id uuid PRIMARY KEY, user_id uuid); ALTER TABLE x.user_profile ADD CONSTRAINT user_ref FOREIGN KEY (user_id) REFERENCES auth.users(id);',
    );
    expect(manyToOne.issues.some((issue) => issue.code === 'foreign-key-target')).toBe(true);

    const alterOnly =
      'ALTER TABLE x.user_profile ADD CONSTRAINT user_ref FOREIGN KEY (user_id) REFERENCES auth.users(id);';
    expect(
      (await lint(alterOnly)).issues.some((issue) => issue.code === 'foreign-key-target'),
    ).toBe(true);
    const priorTable = await lintExtensionMigration({
      name: '20261124120000_ext-x_table.sql',
      contents: 'CREATE TABLE x.user_profile (user_id uuid PRIMARY KEY);',
    });
    const laterForeignKey = await lintExtensionMigration(
      { name: '20261124120001_ext-x_fk.sql', contents: alterOnly },
      { knownPrimaryKeyColumns: priorTable.knownPrimaryKeyColumns },
    );
    expect(laterForeignKey.issues).toEqual([]);
  });

  it('rejects foreign keys from extension tables to other protected schemas', async () => {
    const result = await lint(
      'CREATE TABLE x.user_profile (profile_id uuid PRIMARY KEY REFERENCES identity.profiles(id));',
    );
    expect(result.issues[0]?.code).toBe('foreign-key-target');
  });

  it('rejects ALTER TABLE constraints that reference protected schemas outside auth.users(id)', async () => {
    const result = await lint(
      'ALTER TABLE x.user_profile ADD CONSTRAINT profile_fk FOREIGN KEY (profile_id) REFERENCES identity.profiles(id);',
    );
    expect(result.issues[0]?.code).toBe('foreign-key-target');
  });

  it('keeps extension definers with their extension system role and rejects core owner transfers', async () => {
    const sql = `
      CREATE OR REPLACE FUNCTION x.grant_role() RETURNS void
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
      AS $$ BEGIN RETURN; END; $$;
      ALTER FUNCTION x.grant_role() OWNER TO x_system;
    `;
    expect((await lint(sql)).issues).toEqual([]);

    const definitionOnly = sql.replace('ALTER FUNCTION x.grant_role() OWNER TO x_system;', '');
    const missingTransfer = await lint(definitionOnly);
    expect(missingTransfer.issues.some((issue) => issue.code === 'function-owner-transfer')).toBe(
      true,
    );

    for (const owner of ['auth_fn_owner', 'postgres']) {
      const unsafeOwner = await lint(sql.replace('OWNER TO x_system', `OWNER TO ${owner}`));
      expect(unsafeOwner.issues).not.toEqual([]);
    }
  });

  it('rejects a legacy extension auth-function registration path', async () => {
    const sql = `
      CREATE OR REPLACE FUNCTION x.local_helper() RETURNS void
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
      AS $$ BEGIN RETURN; END; $$;
      ALTER FUNCTION x.local_helper() OWNER TO auth_fn_owner;
    `;
    const result = await lint(sql);
    expect(result.issues).not.toEqual([]);
  });

  it('rejects an extension definer with a non-empty search path', async () => {
    const sql = `
      CREATE OR REPLACE FUNCTION x.grant_role() RETURNS void
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = x
      AS $$ BEGIN RETURN; END; $$;
      ALTER FUNCTION x.grant_role() OWNER TO x_system;
    `;
    const result = await lint(sql);
    expect(result.issues.some((issue) => issue.code === 'function-search-path')).toBe(true);
  });

  it('rejects ALTER DEFAULT PRIVILEGES and DDL that tries to move an extension object into a core schema', async () => {
    const defaults = await lint(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA x GRANT SELECT ON TABLES TO x_system;',
    );
    expect(defaults.issues[0]?.code).toBe('alter-default-privileges');

    const schemaMove = await lint('ALTER TABLE x.notes SET SCHEMA audit;');
    expect(schemaMove.issues[0]?.code).toBe('unsupported-statement');
  });

  it('skips only migrations that do not carry the extension filename pattern', async () => {
    const skipped = await lintExtensionMigration({
      name: '20261124120000_core_table.sql',
      contents: 'CREATE TABLE audit.events (id uuid);',
    });
    expect(skipped.isExtensionMigration).toBe(false);
    expect(skipped.issues).toEqual([]);
  });

  it('rejects malformed extension filenames instead of skipping their SQL', async () => {
    const result = await lintExtensionMigration({
      name: '20261124120000_ext-x.sql',
      contents: 'CREATE TABLE audit.hidden (id uuid);',
    });
    expect(result.isExtensionMigration).toBe(true);
    expect(result.issues[0]?.code).toBe('migration-filename');
  });

  it('requires upstream/main for declared derived repositories and rejects non-extension additions or edited migrations', () => {
    expect(() =>
      validateDerivedMigrationNames({
        declaredDerived: true,
        localMigrationNames: ['20261124120000_ext-x_feature.sql'],
      }),
    ).toThrow(/upstream\/main/);

    expect(
      validateDerivedMigrationNames({
        declaredDerived: true,
        localMigrationNames: [
          '20261124120000_core.sql',
          '20261124120000_ext-x_feature.sql',
          '20261124120001_add_panel.sql',
        ],
        upstreamMigrationNames: new Set(['20261124120000_core.sql']),
      }),
    ).toEqual([
      '20261124120001_add_panel.sql is new relative to upstream/main and must use the _ext-<extension>_ filename prefix.',
    ]);

    expect(
      validateDerivedMigrationNames({
        declaredDerived: true,
        localMigrationNames: ['20261124120000_ext-x_feature.sql'],
        upstreamMigrationNames: new Set(['20261124120000_core.sql']),
      }),
    ).toEqual([
      '20261124120000_core.sql from upstream/main is missing locally; merge the upstream migration set.',
    ]);

    expect(
      validateDerivedMigrationNames({
        declaredDerived: true,
        localMigrationNames: ['20261124120000_core.sql'],
        upstreamMigrationNames: new Set(['20261124120000_core.sql']),
        changedMigrationNames: new Set(['20261124120000_core.sql']),
      }),
    ).toEqual([
      '20261124120000_core.sql changes an upstream migration; applied migrations are immutable in derived repositories.',
    ]);
  });

  it('detects generic forks from upstream remote/ref configuration without requiring AGENTS.bootstrap.md', () => {
    expect(
      resolveDerivedRepositoryMode({
        bootstrapFilePresent: false,
        upstreamRemotePresent: true,
        upstreamMainRefPresent: true,
      }),
    ).toBe(true);
    expect(() =>
      resolveDerivedRepositoryMode({
        bootstrapFilePresent: false,
        upstreamRemotePresent: true,
        upstreamMainRefPresent: false,
      }),
    ).toThrow(/upstream\/main/);
    expect(() =>
      resolveDerivedRepositoryMode({
        bootstrapFilePresent: true,
        upstreamRemotePresent: false,
        upstreamMainRefPresent: false,
      }),
    ).toThrow(/upstream\/main/);
  });

  it('parses the closed core Auth-definer registry and rejects extension or caller expansion', () => {
    expect(parseCoreAuthFunctionRegistry({ functions: coreAuthFunctions })).toEqual(
      coreAuthFunctions,
    );
    expect(() =>
      parseCoreAuthFunctionRegistry({
        functions: [
          ...coreAuthFunctions,
          {
            schema: 'x',
            name: 'grant_role',
            signature: '()',
            migration: coreAuthMigrationName,
            owner: 'postgres',
            executeCallers: ['x_system'],
            purpose: 'Extension grant helper.',
          },
        ],
      }),
    ).toThrow(MigrationLintError);
    expect(() =>
      parseCoreAuthFunctionRegistry({
        functions: coreAuthFunctions.map((entry) =>
          entry.name === 'before_user_created'
            ? { ...entry, executeCallers: ['supabase_auth_admin', 'authenticated'] }
            : entry,
        ),
      }),
    ).toThrow(MigrationLintError);
    expect(() =>
      parseCoreAuthFunctionRegistry({
        functions: coreAuthFunctions.map((entry) => ({ ...entry, extra: 'not permitted' })),
      }),
    ).toThrow(MigrationLintError);
    expect(() => parseCoreAuthFunctionRegistry({ functions: coreAuthFunctions.slice(1) })).toThrow(
      MigrationLintError,
    );
    expect(() =>
      parseCoreAuthFunctionRegistry({
        functions: coreAuthFunctions.map((entry) => ({
          ...entry,
          migration: '20261125120000_ext-x_core_auth.sql',
        })),
      }),
    ).toThrow(MigrationLintError);
    expect(() =>
      parseCoreAuthFunctionRegistry({
        functions: [coreAuthFunctions[0], coreAuthFunctions[0], ...coreAuthFunctions.slice(1)],
      }),
    ).toThrow(/Duplicate core Auth-function registry entry/);
  });

  it('binds each core Auth definer to its same migration, owner, SECURITY DEFINER, and empty path', async () => {
    const registrations = parseCoreAuthFunctionRegistry({ functions: coreAuthFunctions });
    expect(await lintCoreAuthFunctionMigrations(coreAuthMigrations, registrations)).toEqual([]);

    const unregisteredTransfer = `
      CREATE FUNCTION identity.unregistered() RETURNS integer
      LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT 1 $$;
      ALTER FUNCTION identity.unregistered() OWNER TO postgres;
      ALTER FUNCTION unqualified_helper() OWNER TO postgres;
    `;
    expect(
      (
        await lintCoreAuthFunctionMigrations(
          [{ name: coreAuthMigrationName, contents: unregisteredTransfer }, coreAuthMigrations[1]!],
          registrations,
        )
      ).some((issue) => issue.code === 'unregistered-postgres-function-owner'),
    ).toBe(true);

    const migrationOwnedFunctions = coreAuthMigration.replace(
      /\s*ALTER FUNCTION identity\.[a-z_]+\([^)]*\) OWNER TO postgres;/g,
      '',
    );
    expect(
      (
        await lintCoreAuthFunctionMigrations(
          [
            { name: coreAuthMigrationName, contents: migrationOwnedFunctions },
            coreAuthMigrations[1]!,
          ],
          registrations,
        )
      ).some((issue) => issue.code === 'core-auth-function-owner'),
    ).toBe(false);

    const wrongOwner = coreAuthMigration.replace(
      'ALTER FUNCTION identity.count_unconfirmed_users() OWNER TO postgres;',
      'ALTER FUNCTION identity.count_unconfirmed_users() OWNER TO identity_system;',
    );
    expect(
      (
        await lintCoreAuthFunctionMigrations(
          [{ name: coreAuthMigrationName, contents: wrongOwner }, coreAuthMigrations[1]!],
          registrations,
        )
      ).some((issue) => issue.code === 'core-auth-function-owner'),
    ).toBe(true);

    expect(
      (
        await lintCoreAuthFunctionMigrations(
          [
            { name: '20261125120001_other.sql', contents: coreAuthMigration },
            coreAuthMigrations[1]!,
          ],
          registrations,
        )
      ).some((issue) => issue.code === 'core-auth-function-migration'),
    ).toBe(true);

    const unsafePath = coreAuthMigration.replace(
      "SET search_path = ''",
      'SET search_path = public',
    );
    expect(
      (
        await lintCoreAuthFunctionMigrations(
          [{ name: coreAuthMigrationName, contents: unsafePath }, coreAuthMigrations[1]!],
          registrations,
        )
      ).some((issue) => issue.code === 'function-search-path'),
    ).toBe(true);
  });

  it('rejects a registered core Auth owner transfer with a different signature or caller context', async () => {
    const registrations = parseCoreAuthFunctionRegistry({ functions: coreAuthFunctions });
    const wrongSignature = coreAuthMigration.replace(
      'identity.before_user_created(jsonb)',
      'identity.before_user_created(text)',
    );
    expect(
      (
        await lintCoreAuthFunctionMigrations(
          [{ name: coreAuthMigrationName, contents: wrongSignature }, coreAuthMigrations[1]!],
          registrations,
        )
      ).some((issue) => issue.code === 'unregistered-postgres-function-owner'),
    ).toBe(true);
  });

  it('rejects the removed owner role and unregistered SECURITY DEFINER functions left owned by the migration role', async () => {
    const registrations = parseCoreAuthFunctionRegistry({ functions: coreAuthFunctions });
    const legacyOwner = await lintCoreAuthFunctionMigrations(
      [
        {
          name: coreAuthMigrationName,
          contents: 'CREATE ROLE auth_fn_owner NOLOGIN;',
        },
        coreAuthMigrations[1]!,
      ],
      registrations,
    );
    expect(legacyOwner.some((issue) => issue.code === 'legacy-auth-owner')).toBe(true);

    const defaultOwner = await lintCoreAuthFunctionMigrations(
      [
        {
          name: coreAuthMigrationName,
          contents: `
            CREATE FUNCTION ops.unregistered_helper() RETURNS integer
            LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT 1 $$;
          `,
        },
        coreAuthMigrations[1]!,
      ],
      registrations,
    );
    expect(
      defaultOwner.some((issue) => issue.code === 'unregistered-postgres-function-owner'),
    ).toBe(true);
  });

  it('runs the fixed core registry against core migrations and still rejects extension ownership escalation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'base-app-migration-lint-'));
    const migrationDirectory = join(root, 'supabase', 'migrations');
    const testDirectory = join(root, 'supabase', 'tests');
    mkdirSync(migrationDirectory, { recursive: true });
    mkdirSync(testDirectory, { recursive: true });
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    writeFileSync(
      join(testDirectory, 'core-auth-fn-registry.json'),
      JSON.stringify({ functions: coreAuthFunctions }),
      'utf8',
    );
    writeFileSync(join(migrationDirectory, coreAuthMigrationName), coreAuthMigration, 'utf8');
    writeFileSync(join(migrationDirectory, w4CoreAuthMigrationName), w4CoreAuthMigration, 'utf8');
    writeFileSync(
      join(migrationDirectory, '20261125120001_ext-x_owner.sql'),
      `
        CREATE FUNCTION x.helper() RETURNS void
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$ BEGIN RETURN; END; $$;
        ALTER FUNCTION x.helper() OWNER TO postgres;
      `,
      'utf8',
    );

    try {
      const result = await lintExtensionMigrations(root);
      expect(result.checked).toBe(1);
      expect(result.coreChecked).toBe(2);
      expect(
        result.issues.some(
          (entry) =>
            entry.migration === '20261125120001_ext-x_owner.sql' &&
            entry.issue.code === 'extension-function-owner',
        ),
      ).toBe(true);

      const legacyRegistryDirectory = join(testDirectory, 'auth-fn-registry.d');
      mkdirSync(legacyRegistryDirectory);
      writeFileSync(join(legacyRegistryDirectory, 'x.json'), '{}', 'utf8');
      await expect(lintExtensionMigrations(root)).rejects.toThrow(
        /auth-fn-registry.d is no longer supported/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('parses strict extension group-members registries', () => {
    const groups = parseExpectedGroupMemberDocuments([
      {
        filename: 'supabase/tests/expected-group-members.d/x.json',
        extensionSchema: 'x',
        document: { audit_writer: ['x_system', 'x_admin_grantor'] },
      },
    ]);
    expect(groups.get('audit_writer')).toEqual(new Set(['x_system', 'x_admin_grantor']));
    expect(() =>
      parseExpectedGroupMemberDocuments([
        {
          filename: 'supabase/tests/expected-group-members.d/x.json',
          extensionSchema: 'x',
          document: { audit_writer: ['y_system'] },
        },
      ]),
    ).toThrow(/must start with x_/);
  });
});
