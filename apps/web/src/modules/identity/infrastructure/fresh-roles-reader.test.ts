import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import type { DbClaims } from '../../../platform/db';
import type { AppLogger } from '../../../platform/observability/logger';
import type { DatabaseEnvironment } from '../../../platform/env';
import { createDatabaseRuntime } from '../../../platform/db/runtime';
import { createFreshRolesReader } from './fresh-roles-reader';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CLAIMS: DbClaims = {
  sub: USER_ID,
  role: 'authenticated',
  aal: 'aal1',
  session_id: '22222222-2222-4222-8222-222222222222',
};
const DATABASE_ENVIRONMENT: DatabaseEnvironment = {
  DATABASE_URL: 'postgresql://api_runtime:secret@db.example.invalid:6543/postgres',
  DATABASE_CA_CERT: '-----BEGIN CERTIFICATE-----\nlocal-test-ca\n-----END CERTIFICATE-----',
};

type QueryCall = { readonly text: string; readonly values: readonly unknown[] };
type FakeQuery = string | { readonly text: string; readonly values?: readonly unknown[] };

function createLogger(warnings: unknown[]): AppLogger {
  return {
    info() {},
    error() {},
    warn(message, fields) {
      warnings.push({ message, fields });
    },
  };
}

function createRuntime(roleValue: unknown) {
  const calls: QueryCall[] = [];
  const connect = vi.fn(async () => ({
    async query(query: FakeQuery, values?: readonly unknown[]) {
      const text = typeof query === 'string' ? query : query.text;
      const parameters = values ?? (typeof query === 'string' ? [] : (query.values ?? []));
      calls.push({ text, values: parameters });
      const rows = text.includes('identity.read_fresh_roles') ? [{ roles: roleValue }] : [];
      return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
    },
    release() {},
  }));
  const pool = {
    connect,
    on() {},
    async end() {},
  } as unknown as Pool;
  const runtime = createDatabaseRuntime(
    DATABASE_ENVIRONMENT,
    { extensionSystemRoles: [], logger: createLogger([]) },
    { createPool: () => pool, attachDatabasePool() {} },
  );
  return { runtime, calls, connect };
}

describe('fresh role reader', () => {
  it('binds the user UUID and forwards all verified database claims to userScopedDb', async () => {
    const { runtime, calls } = createRuntime(['admin', 'support_1']);
    const warnings: unknown[] = [];

    try {
      const roles = await createFreshRolesReader(
        runtime,
        createLogger(warnings),
      )({
        userId: USER_ID,
        dbClaims: CLAIMS,
      });

      expect(roles).toEqual(['admin', 'support_1']);
      const claimsQuery = calls.find((call) =>
        call.text.includes("set_config('request.jwt.claims'"),
      );
      expect(claimsQuery?.values).toEqual(['authenticated', JSON.stringify(CLAIMS)]);
      const roleQuery = calls.find((call) => call.text.includes('identity.read_fresh_roles'));
      expect(roleQuery?.text).toContain('identity.read_fresh_roles($1::uuid)');
      expect(roleQuery?.values).toEqual([USER_ID]);
      expect(warnings).toEqual([]);
    } finally {
      await runtime.destroy();
    }
  });

  it('returns an empty list for missing metadata and logs invalid values without their contents', async () => {
    for (const roleValue of [
      undefined,
      ['admin', 'bad role'],
      Array.from({ length: 11 }, (_, i) => `role_${i}`),
    ]) {
      const { runtime } = createRuntime(roleValue);
      const warnings: unknown[] = [];
      try {
        await expect(
          createFreshRolesReader(
            runtime,
            createLogger(warnings),
          )({ userId: USER_ID, dbClaims: CLAIMS }),
        ).resolves.toEqual([]);
        if (roleValue === undefined) expect(warnings).toEqual([]);
        else expect(JSON.stringify(warnings)).not.toContain(JSON.stringify(roleValue));
      } finally {
        await runtime.destroy();
      }
    }
  });

  it('rejects a context whose user id differs from its verified claims before opening a transaction', async () => {
    const { runtime, connect } = createRuntime([]);
    try {
      await expect(
        createFreshRolesReader(
          runtime,
          createLogger([]),
        )({
          userId: '33333333-3333-4333-8333-333333333333',
          dbClaims: CLAIMS,
        }),
      ).rejects.toThrow('Verified user does not match database claims.');
      expect(connect).not.toHaveBeenCalled();
    } finally {
      await runtime.destroy();
    }
  });
});
