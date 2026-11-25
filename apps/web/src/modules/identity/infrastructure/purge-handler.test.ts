import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import type { AppLogger } from '../../../platform/observability/logger';
import type { DatabaseEnvironment } from '../../../platform/env';
import { createDatabaseRuntime } from '../../../platform/db/runtime';
import { ACCOUNT_PURGE_REQUESTED, type AccountPurgeRequested } from '../../../platform/events';
import { createIdentityPurgeHandler } from './purge-handler';

const DATABASE_ENVIRONMENT: DatabaseEnvironment = {
  DATABASE_URL: 'postgresql://api_runtime:secret@db.example.invalid:6543/postgres',
  DATABASE_CA_CERT: '-----BEGIN CERTIFICATE-----\nlocal-test-ca\n-----END CERTIFICATE-----',
};
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

type QueryCall = { readonly text: string; readonly values: readonly unknown[] };
type FakeQuery = string | { readonly text: string; readonly values?: readonly unknown[] };

function fakeLogger(): AppLogger {
  return { info() {}, warn() {}, error() {} };
}

function createRuntime() {
  const calls: QueryCall[] = [];
  const connect = vi.fn(async () => ({
    async query(query: FakeQuery, values?: readonly unknown[]) {
      const text = typeof query === 'string' ? query : query.text;
      const parameters = values ?? (typeof query === 'string' ? [] : (query.values ?? []));
      calls.push({ text, values: parameters });
      return { rows: [], rowCount: 0, command: 'DELETE', oid: 0, fields: [] };
    },
    release() {},
  }));
  const pool = { connect, on() {}, async end() {} } as unknown as Pool;
  const runtime = createDatabaseRuntime(
    DATABASE_ENVIRONMENT,
    { extensionSystemRoles: [], logger: fakeLogger() },
    { createPool: () => pool, attachDatabasePool() {} },
  );
  return { runtime, calls, connect };
}

function event(userId: string): AccountPurgeRequested {
  return {
    type: ACCOUNT_PURGE_REQUESTED,
    userId,
    reason: 'user_request',
    caller: 'policy:immediate',
    occurredAt: '2026-11-25T12:00:00.000Z',
    correlationId: '00000000-0000-7000-8000-000000000001',
  };
}

describe('identity account purge handler', () => {
  it('deletes only the requested user, is repeatable, and uses the caller-owned identity transaction', async () => {
    const { runtime, calls, connect } = createRuntime();
    const handler = createIdentityPurgeHandler;
    try {
      await runtime.systemDb('identity', async (transaction) => {
        const boundHandler = handler(transaction);
        await boundHandler(event(USER_A));
        await boundHandler(event(USER_A));
      });

      const roleCall = calls.find((call) => call.text.includes("set_config('role'"));
      const deletes = calls.filter((call) => call.text.toLowerCase().includes('delete from'));
      expect(roleCall?.values).toContain('identity_system');
      expect(connect).toHaveBeenCalledTimes(1);
      expect(deletes).toHaveLength(2);
      expect(deletes[0]?.text).toContain('"identity"."profiles"');
      expect(deletes[0]?.text).toMatch(/where\s+"user_id"\s*=\s*\$1/i);
      expect(deletes.map((call) => call.values)).toEqual([[USER_A], [USER_A]]);
      expect(deletes.flatMap((call) => call.values)).not.toContain(USER_B);
    } finally {
      await runtime.destroy();
    }
  });

  it('leaves commit and rollback decisions to the transaction caller', async () => {
    const { runtime, calls } = createRuntime();
    try {
      await expect(
        runtime.systemDb('identity', async (transaction) => {
          await createIdentityPurgeHandler(transaction)(event(USER_A));
          throw new Error('caller rollback');
        }),
      ).rejects.toThrow('caller rollback');

      expect(calls.some((call) => call.text.toLowerCase() === 'rollback')).toBe(true);
      expect(calls.some((call) => call.text.toLowerCase() === 'commit')).toBe(false);
      expect(
        calls.some((call) => call.text.toLowerCase().includes('delete from "identity"."profiles"')),
      ).toBe(true);
    } finally {
      await runtime.destroy();
    }
  });
});
