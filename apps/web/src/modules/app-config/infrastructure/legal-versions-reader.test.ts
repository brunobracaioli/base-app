import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { createDatabaseRuntime } from '../../../platform/db/runtime';
import type { AppLogger } from '../../../platform/observability/logger';
import type { DatabaseEnvironment } from '../../../platform/env';
import { InvalidLegalVersionsError } from '../domain/legal-versions';
import { createLegalVersionsReader } from './legal-versions-reader';

const DATABASE_ENVIRONMENT: DatabaseEnvironment = {
  DATABASE_URL: 'postgresql://api_runtime:secret@db.example.invalid:6543/postgres',
  DATABASE_CA_CERT: '-----BEGIN CERTIFICATE-----\nlocal-test-ca\n-----END CERTIFICATE-----',
};
const LEGAL_VALUE = { termsVersion: '2026-11-24', privacyVersion: '2026-11-25' };

type QueryCall = { readonly text: string; readonly values: readonly unknown[] };
type FakeQuery = string | { readonly text: string; readonly values?: readonly unknown[] };

function createRuntime(value: unknown) {
  const calls: QueryCall[] = [];
  const client = {
    async query(query: FakeQuery, values?: readonly unknown[]) {
      const text = typeof query === 'string' ? query : query.text;
      const parameters = values ?? (typeof query === 'string' ? [] : (query.values ?? []));
      calls.push({ text, values: parameters });
      const rows =
        text.includes('"app_config"."settings"') && value !== undefined ? [{ value }] : [];
      return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
    },
    release() {},
  };
  const pool = {
    async connect() {
      return client;
    },
    on() {},
    async end() {},
  } as unknown as Pool;
  const logger: AppLogger = { info() {}, warn() {}, error() {} };
  const runtime = createDatabaseRuntime(
    DATABASE_ENVIRONMENT,
    { extensionSystemRoles: [], logger },
    { createPool: () => pool, attachDatabasePool() {} },
  );
  return { runtime, calls };
}

describe('app-config legal versions reader', () => {
  it('reads only the authoritative legal setting under app_config_system', async () => {
    const { runtime, calls } = createRuntime(LEGAL_VALUE);
    try {
      await expect(createLegalVersionsReader(runtime).readCurrent()).resolves.toEqual(LEGAL_VALUE);

      const roleCall = calls.find((call) => call.text.includes("set_config('role'"));
      const select = calls.find((call) => call.text.includes('"app_config"."settings"'));
      expect(roleCall?.values).toContain('app_config_system');
      expect(select?.text.toLowerCase()).toMatch(/where\s+"key"\s*=\s*\$1/);
      expect(select?.values).toEqual(['legal']);
    } finally {
      await runtime.destroy();
    }
  });

  it('fails closed when the legal setting is absent or invalid', async () => {
    const { runtime: invalidRuntime } = createRuntime({
      termsVersion: '2025-02-29',
      privacyVersion: '2026-11-25',
    });
    const { runtime: missingRuntime } = createRuntime(undefined);
    try {
      await expect(createLegalVersionsReader(invalidRuntime).readCurrent()).rejects.toBeInstanceOf(
        InvalidLegalVersionsError,
      );
      await expect(createLegalVersionsReader(missingRuntime).readCurrent()).rejects.toThrow(
        'Current legal versions are unavailable.',
      );
    } finally {
      await invalidRuntime.destroy();
      await missingRuntime.destroy();
    }
  });
});
