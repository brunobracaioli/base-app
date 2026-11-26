import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migrationPath = fileURLToPath(
  new URL(
    '../../../../supabase/migrations/20261126005523_w5_app_config_operations.sql',
    import.meta.url,
  ),
);

describe('W5 app-config migration ownership order', () => {
  it('replaces and changes the legacy setter ACL as app_config_admin', () => {
    const migration = readFileSync(migrationPath, 'utf8');
    const adminRole = migration.indexOf("select set_config('role', 'app_config_admin', true);");
    const replaceLegacySetter = migration.indexOf(
      'create or replace function app_config.set_setting(\n' +
        '  p_key text, p_value jsonb, p_actor_type text, p_actor_ref text,\n' +
        '  p_correlation_id text, p_expected_updated_at timestamptz\n' +
        ') returns void',
    );
    const alterLegacyOwner = migration.indexOf(
      'alter function app_config.set_setting(text, jsonb, text, text, text, timestamptz)\n' +
        '  owner to app_config_admin;',
      replaceLegacySetter,
    );
    const setterAcl = migration.indexOf(
      'revoke all on function app_config.set_setting(',
      replaceLegacySetter,
    );
    const writerGrant = migration.indexOf('to app_config_writer;', setterAcl);
    const returnToPostgres = migration.indexOf(
      "select set_config('role', 'postgres', true);",
      adminRole,
    );

    expect(adminRole).toBeGreaterThanOrEqual(0);
    expect(replaceLegacySetter).toBeGreaterThan(adminRole);
    expect(alterLegacyOwner).toBeGreaterThan(replaceLegacySetter);
    expect(setterAcl).toBeGreaterThan(alterLegacyOwner);
    expect(writerGrant).toBeGreaterThan(setterAcl);
    expect(returnToPostgres).toBeGreaterThan(writerGrant);
  });
});
