import { describe, expect, it } from 'vitest';
import {
  lintExtensionMigration,
  MigrationLintError,
  parseAuthFunctionRegistryDocuments,
  parseExpectedGroupMemberDocuments,
  resolveDerivedRepositoryMode,
  validateDerivedMigrationNames,
} from './db-lint-migrations.js';

const migrationName = '20261124120000_ext-x_guard.sql';

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

  it('requires security definer, an empty search path and registry metadata for auth_fn_owner transfer', async () => {
    const sql = `
      CREATE OR REPLACE FUNCTION x.grant_role() RETURNS void
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
      AS $$ BEGIN RETURN; END; $$;
      ALTER FUNCTION x.grant_role() OWNER TO auth_fn_owner;
    `;
    const registration = [
      { name: 'x.grant_role', signature: '()', reason: 'Maintains extension roles.' },
    ];

    const missingRegistry = await lint(sql);
    expect(
      missingRegistry.issues.some(
        (issue) =>
          issue.code === 'unregistered-security-definer' || issue.code === 'auth-function-owner',
      ),
    ).toBe(true);

    const valid = await lint(sql, { registeredFunctions: registration });
    expect(valid.issues).toEqual([]);

    const definitionOnly = sql.replace('ALTER FUNCTION x.grant_role() OWNER TO auth_fn_owner;', '');
    const missingTransfer = await lint(definitionOnly, { registeredFunctions: registration });
    expect(missingTransfer.issues.some((issue) => issue.code === 'function-owner-transfer')).toBe(
      true,
    );

    const extensionOwner = sql.replace('OWNER TO auth_fn_owner', 'OWNER TO x_system');
    const unsafeOwner = await lint(extensionOwner, { registeredFunctions: registration });
    expect(unsafeOwner.issues.some((issue) => issue.code === 'extension-function-owner')).toBe(
      true,
    );
  });

  it('uses the extension system role for unregistered own-schema security definers', async () => {
    const sql = `
      CREATE OR REPLACE FUNCTION x.local_helper() RETURNS void
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
      AS $$ BEGIN RETURN; END; $$;
      ALTER FUNCTION x.local_helper() OWNER TO x_system;
    `;
    expect((await lint(sql)).issues).toEqual([]);
    expect(
      (await lint(sql.replace('OWNER TO x_system', 'OWNER TO auth_fn_owner'))).issues.some(
        (issue) => issue.code === 'auth-function-owner',
      ),
    ).toBe(true);
  });

  it('rejects an auth_fn_owner function with a non-empty search path', async () => {
    const sql = `
      CREATE OR REPLACE FUNCTION x.grant_role() RETURNS void
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = x
      AS $$ BEGIN RETURN; END; $$;
      ALTER FUNCTION x.grant_role() OWNER TO auth_fn_owner;
    `;
    const result = await lint(sql, {
      registeredFunctions: [
        { name: 'x.grant_role', signature: '()', reason: 'Maintains extension roles.' },
      ],
    });
    expect(
      result.issues.some(
        (issue) => issue.code === 'function-search-path' || issue.code === 'auth-function-owner',
      ),
    ).toBe(true);
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

  it('parses strict, extension-scoped auth-function and group-members registries', () => {
    const functions = parseAuthFunctionRegistryDocuments([
      {
        filename: 'supabase/tests/auth-fn-registry.d/x.json',
        extensionSchema: 'x',
        document: {
          functions: [
            { name: 'grant_role', signature: '()', reason: 'Updates allowed extension roles.' },
          ],
        },
      },
    ]);
    expect(functions).toEqual([
      { name: 'x.grant_role', signature: '()', reason: 'Updates allowed extension roles.' },
    ]);
    expect(() =>
      parseAuthFunctionRegistryDocuments([
        {
          filename: 'supabase/tests/auth-fn-registry.d/x.json',
          extensionSchema: 'x',
          document: {
            functions: [
              { name: 'grant_role', signature: '()', reason: 'ok', arbitrary: 'ignored' },
            ],
          },
        },
      ]),
    ).toThrow(MigrationLintError);
    expect(() =>
      parseAuthFunctionRegistryDocuments([
        {
          filename: 'supabase/tests/auth-fn-registry.d/x.json',
          extensionSchema: 'x',
          document: {
            functions: [
              { name: 'grant_role', signature: '()', reason: 'first' },
              { name: 'grant_role', signature: '()', reason: 'duplicate' },
            ],
          },
        },
      ]),
    ).toThrow(/Duplicate auth function registry entry/);

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
