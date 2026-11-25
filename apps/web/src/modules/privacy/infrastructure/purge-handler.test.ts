import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import type { AppLogger } from '../../../platform/observability/logger';
import type { DatabaseEnvironment } from '../../../platform/env';
import { createDatabaseRuntime } from '../../../platform/db/runtime';
import { ACCOUNT_PURGE_REQUESTED, type AccountPurgeRequested } from '../../../platform/events';
import { createPrivacyPurgeHandler } from './purge-handler';

const DATABASE_ENVIRONMENT: DatabaseEnvironment = {
  DATABASE_URL: 'postgresql://api_runtime:secret@db.example.invalid:6543/postgres',
  DATABASE_CA_CERT: '-----BEGIN CERTIFICATE-----\nlocal-test-ca\n-----END CERTIFICATE-----',
};
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

type QueryCall = { readonly text: string; readonly values: readonly unknown[] };
type FakeQuery = string | { readonly text: string; readonly values?: readonly unknown[] };

function createRuntime() {
  const calls: QueryCall[] = [];
  const client = {
    async query(query: FakeQuery, values?: readonly unknown[]) {
      const text = typeof query === 'string' ? query : query.text;
      const parameters = values ?? (typeof query === 'string' ? [] : (query.values ?? []));
      calls.push({ text, values: parameters });
      return { rows: [], rowCount: 0, command: 'DELETE', oid: 0, fields: [] };
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

function event(userId: string): AccountPurgeRequested {
  return {
    type: ACCOUNT_PURGE_REQUESTED,
    userId,
    reason: 'scheduled',
    caller: 'job:cleanup',
    occurredAt: '2026-11-25T12:00:00.000Z',
    correlationId: '00000000-0000-7000-8000-000000000001',
  };
}

describe('privacy account purge handler', () => {
  it('deletes only the requested user with the privacy role and accepts a repeated event', async () => {
    const { runtime, calls } = createRuntime();
    try {
      await runtime.systemDb('privacy', async (transaction) => {
        const boundHandler = createPrivacyPurgeHandler(transaction);
        await boundHandler(event(USER_A));
        await boundHandler(event(USER_A));
      });

      const roleCall = calls.find((call) => call.text.includes("set_config('role'"));
      const deletes = calls.filter((call) => call.text.toLowerCase().includes('delete from'));
      expect(roleCall?.values).toContain('privacy_system');
      expect(deletes).toHaveLength(2);
      expect(deletes[0]?.text).toContain('"privacy"."consents"');
      expect(deletes[0]?.text).toMatch(/where\s+"user_id"\s*=\s*\$1/i);
      expect(deletes.map((call) => call.values)).toEqual([[USER_A], [USER_A]]);
      expect(deletes.flatMap((call) => call.values)).not.toContain(USER_B);
    } finally {
      await runtime.destroy();
    }
  });

  it('rolls back when the transaction caller fails after the handler', async () => {
    const { runtime, calls } = createRuntime();
    try {
      await expect(
        runtime.systemDb('privacy', async (transaction) => {
          await createPrivacyPurgeHandler(transaction)(event(USER_A));
          throw new Error('caller rollback');
        }),
      ).rejects.toThrow('caller rollback');
      expect(calls.some((call) => call.text.toLowerCase() === 'rollback')).toBe(true);
      expect(calls.some((call) => call.text.toLowerCase() === 'commit')).toBe(false);
    } finally {
      await runtime.destroy();
    }
  });
});
