import { Pool } from 'pg';
import {
  PostgresDialect,
  type CompiledQuery,
  type QueryExecutor,
  type QueryExecutorProvider,
  type QueryResult,
} from 'kysely';
import { describe, expect, it } from 'vitest';

import { MemoryIdempotencyStore } from '../testing/route-dependencies';
import {
  createPostgresIdempotencyStore,
  type PlatformTransactionRunner,
} from './idempotency-store.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const KEY = '33333333-3333-4333-8333-333333333333';
const REQUEST_HASH = 'a'.repeat(64);
const NOW = new Date('2026-11-24T12:00:00.000Z');

function createStore(responses: readonly unknown[][] = []): {
  readonly store: ReturnType<typeof createPostgresIdempotencyStore>;
  readonly queries: CompiledQuery<unknown>[];
} {
  const queries: CompiledQuery<unknown>[] = [];
  const dialect = new PostgresDialect({
    pool: new Pool({ connectionString: 'postgres://test:test@127.0.0.1:1/test' }),
  });
  const compiler = dialect.createQueryCompiler();
  let responseIndex = 0;
  const executor = {
    transformQuery(node: Parameters<QueryExecutor['transformQuery']>[0]) {
      return node;
    },
    compileQuery(
      node: Parameters<QueryExecutor['compileQuery']>[0],
      queryId: Parameters<QueryExecutor['compileQuery']>[1],
    ) {
      return compiler.compileQuery(node, queryId);
    },
    async executeQuery<R>(query: CompiledQuery<R>): Promise<QueryResult<R>> {
      queries.push(query as CompiledQuery<unknown>);
      const rows = responses[responseIndex] ?? [];
      responseIndex += 1;
      return { rows: rows as R[] };
    },
  } as unknown as QueryExecutor;
  const provider = { getExecutor: () => executor } as QueryExecutorProvider;
  const runner: PlatformTransactionRunner = <Result>(
    work: (transaction: QueryExecutorProvider) => Promise<Result>,
  ) => work(provider);
  return { store: createPostgresIdempotencyStore(runner), queries };
}

describe('Postgres idempotency adapter', () => {
  it('uses bound values for the atomic claim instead of interpolating user data', async () => {
    const { store, queries } = createStore([
      [{ request_hash: REQUEST_HASH, state: 'in_progress' }],
    ]);
    const result = await store.acquire({
      userId: USER_ID,
      key: KEY,
      requestHash: REQUEST_HASH,
      now: NOW,
      leaseUntil: new Date(NOW.getTime() + 60_000),
      expiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1_000),
    });
    expect(result).toEqual({
      kind: 'acquired',
      leaseUntil: new Date(NOW.getTime() + 60_000),
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toContain('on conflict');
    expect(queries[0]?.sql).not.toContain(USER_ID);
    expect(queries[0]?.parameters).toContain(USER_ID);
    expect(queries[0]?.parameters).toContain(KEY);
  });

  it('replays a completed database row with the same request hash', async () => {
    const { store } = createStore([
      [],
      [
        {
          request_hash: REQUEST_HASH,
          state: 'completed',
          locked_until: new Date(NOW.getTime() + 60_000),
          expires_at: new Date(NOW.getTime() + 24 * 60 * 60 * 1_000),
          response_status: 200,
          response_body: { ok: true },
        },
      ],
    ]);
    const result = await store.acquire({
      userId: USER_ID,
      key: KEY,
      requestHash: REQUEST_HASH,
      now: NOW,
      leaseUntil: new Date(NOW.getTime() + 60_000),
      expiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1_000),
    });
    expect(result).toEqual({ kind: 'completed', response: { status: 200, body: { ok: true } } });
  });

  it('stores the completed response and deletes only the matching in-progress lease', async () => {
    const { store, queries } = createStore([[{ key: KEY }], []]);
    await store.complete({
      userId: USER_ID,
      key: KEY,
      requestHash: REQUEST_HASH,
      leaseUntil: new Date(NOW.getTime() + 60_000),
      response: { status: 200, body: { ok: true } },
    });
    await store.release({
      userId: USER_ID,
      key: KEY,
      requestHash: REQUEST_HASH,
      leaseUntil: new Date(NOW.getTime() + 60_000),
    });
    expect(queries[0]?.sql).toContain('update platform.idempotency_keys');
    expect(queries[0]?.sql).toContain('locked_until');
    expect(queries[0]?.parameters).toContain(JSON.stringify({ ok: true }));
    expect(queries[1]?.sql).toContain('delete from platform.idempotency_keys');
    expect(queries[1]?.sql).toContain('locked_until');
  });

  it('fences a stale worker after another request reclaims its expired lease', async () => {
    const store = new MemoryIdempotencyStore();
    const firstLease = new Date(NOW.getTime() + 60_000);
    const secondNow = new Date(firstLease.getTime() + 1);
    const secondLease = new Date(secondNow.getTime() + 60_000);
    const expiresAt = new Date(NOW.getTime() + 24 * 60 * 60 * 1_000);
    const firstClaim = await store.acquire({
      userId: USER_ID,
      key: KEY,
      requestHash: REQUEST_HASH,
      now: NOW,
      leaseUntil: firstLease,
      expiresAt,
    });
    const secondClaim = await store.acquire({
      userId: USER_ID,
      key: KEY,
      requestHash: REQUEST_HASH,
      now: secondNow,
      leaseUntil: secondLease,
      expiresAt,
    });
    expect(firstClaim).toEqual({ kind: 'acquired', leaseUntil: firstLease });
    expect(secondClaim).toEqual({ kind: 'acquired', leaseUntil: secondLease });

    await expect(
      store.complete({
        userId: USER_ID,
        key: KEY,
        requestHash: REQUEST_HASH,
        leaseUntil: firstLease,
        response: { status: 200, body: { owner: 'stale' } },
      }),
    ).rejects.toThrow(/lease is not owned/);
    await store.release({
      userId: USER_ID,
      key: KEY,
      requestHash: REQUEST_HASH,
      leaseUntil: firstLease,
    });
    expect(
      await store.acquire({
        userId: USER_ID,
        key: KEY,
        requestHash: REQUEST_HASH,
        now: secondNow,
        leaseUntil: new Date(secondLease.getTime() + 60_000),
        expiresAt,
      }),
    ).toEqual({ kind: 'in_progress' });
    await store.complete({
      userId: USER_ID,
      key: KEY,
      requestHash: REQUEST_HASH,
      leaseUntil: secondLease,
      response: { status: 200, body: { owner: 'current' } },
    });
  });
});
