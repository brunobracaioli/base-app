import { sql, type QueryExecutorProvider } from 'kysely';

import type {
  IdempotencyAcquireResult,
  IdempotencyStore,
  StoredIdempotencyResponse,
} from './types';

export type PlatformTransactionRunner = <Result>(
  work: (transaction: QueryExecutorProvider) => Promise<Result>,
) => Promise<Result>;

type IdempotencyRow = {
  readonly request_hash: string;
  readonly state: 'in_progress' | 'completed';
  readonly locked_until: Date | string;
  readonly expires_at: Date | string;
  readonly response_status: number | null;
  readonly response_body: unknown;
};

function timestampMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

function rowResponse(row: IdempotencyRow): StoredIdempotencyResponse {
  if (row.response_status === null || row.response_body === null) {
    throw new Error('Completed idempotency row has no stored response.');
  }
  return { status: row.response_status, body: row.response_body };
}

function serializeResponseBody(body: unknown): string {
  const serialized = JSON.stringify(body);
  if (serialized === undefined)
    throw new TypeError('Idempotency response is not JSON serializable.');
  return serialized;
}

export function createPostgresIdempotencyStore(
  withPlatformTransaction: PlatformTransactionRunner,
): IdempotencyStore {
  return {
    async acquire(input): Promise<IdempotencyAcquireResult> {
      return withPlatformTransaction(async (transaction) => {
        const claimed = await sql<Pick<IdempotencyRow, 'request_hash' | 'state'>>`
          insert into platform.idempotency_keys (
            user_id, key, request_hash, state, locked_until, expires_at
          ) values (
            ${input.userId}::uuid,
            ${input.key}::uuid,
            ${input.requestHash},
            'in_progress',
            ${input.leaseUntil},
            ${input.expiresAt}
          )
          on conflict (user_id, key) do update set
            request_hash = excluded.request_hash,
            state = 'in_progress',
            locked_until = excluded.locked_until,
            response_status = null,
            response_body = null,
            expires_at = excluded.expires_at
          where platform.idempotency_keys.expires_at <= ${input.now}
            or (
              platform.idempotency_keys.state = 'in_progress'
              and platform.idempotency_keys.locked_until <= ${input.now}
              and platform.idempotency_keys.request_hash = ${input.requestHash}
            )
          returning request_hash, state
        `.execute(transaction);
        if (claimed.rows.length > 0) return { kind: 'acquired', leaseUntil: input.leaseUntil };

        const result = await sql<IdempotencyRow>`
          select request_hash, state, locked_until, expires_at, response_status, response_body
          from platform.idempotency_keys
          where user_id = ${input.userId}::uuid and key = ${input.key}::uuid
          for update
        `.execute(transaction);
        const existing = result.rows[0];
        if (!existing) throw new Error('Idempotency row disappeared during claim.');
        if (timestampMs(existing.expires_at) <= input.now.getTime()) {
          throw new Error('Expired idempotency row was not reclaimed.');
        }
        if (existing.request_hash !== input.requestHash) return { kind: 'key_reused' };
        if (existing.state === 'completed') {
          return { kind: 'completed', response: rowResponse(existing) };
        }
        return { kind: 'in_progress' };
      });
    },

    async complete(input): Promise<void> {
      await withPlatformTransaction(async (transaction) => {
        const result = await sql<{ readonly key: string }>`
          update platform.idempotency_keys
          set state = 'completed',
              response_status = ${input.response.status},
              response_body = ${serializeResponseBody(input.response.body)}::jsonb
          where user_id = ${input.userId}::uuid
            and key = ${input.key}::uuid
            and request_hash = ${input.requestHash}
            and locked_until = ${input.leaseUntil}
            and state = 'in_progress'
          returning key
        `.execute(transaction);
        if (result.rows.length === 0)
          throw new Error('Idempotency lease is no longer owned by this request.');
      });
    },

    async release(input): Promise<void> {
      await withPlatformTransaction(async (transaction) => {
        await sql`
          delete from platform.idempotency_keys
          where user_id = ${input.userId}::uuid
            and key = ${input.key}::uuid
            and request_hash = ${input.requestHash}
            and locked_until = ${input.leaseUntil}
            and state = 'in_progress'
        `.execute(transaction);
      });
    },
  };
}
