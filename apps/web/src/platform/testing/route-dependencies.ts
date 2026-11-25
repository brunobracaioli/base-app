import type { AuthorizationPolicy, UserAuthContext } from '../authorization/types';
import type { AuthVerificationResult } from '../auth/types';
import type { AppLogger } from '../observability/logger';
import type { IdempotencyAcquireResult, IdempotencyStore, RouteDependencies } from '../http/types';
import type { RateLimiter, RateLimitResult } from '../http/rate-limit';

export const TEST_NOW = new Date('2026-11-24T12:00:00.000Z');
export const TEST_REQUEST_ID = '00000000-0000-7000-8000-000000000001';
export const TEST_USER_A = '11111111-1111-4111-8111-111111111111';
export const TEST_USER_B = '22222222-2222-4222-8222-222222222222';
export const TEST_IDEMPOTENCY_KEY = '33333333-3333-4333-8333-333333333333';
export const TEST_SESSION_ID = '55555555-5555-4555-8555-555555555555';

export function createTestUserAuthContext(
  userId = TEST_USER_A,
  amr: UserAuthContext['amr'] = [{ method: 'email', timestamp: TEST_NOW.getTime() / 1_000 }],
): UserAuthContext {
  return {
    kind: 'user',
    userId,
    sessionId: TEST_SESSION_ID,
    aal: 'aal1',
    email: null,
    isAnonymous: false,
    appRoles: [],
    providers: ['email'],
    amr,
    dbClaims: {
      sub: userId,
      role: 'authenticated',
      aal: 'aal1',
      session_id: TEST_SESSION_ID,
    },
  };
}

export type CapturedLog = {
  readonly level: 'info' | 'warn' | 'error';
  readonly fields: Readonly<Record<string, unknown>>;
  readonly message: string;
};

export class RecordingRateLimiter implements RateLimiter {
  readonly calls: Array<Parameters<RateLimiter['consume']>[0]> = [];
  readonly order: string[];
  result: RateLimitResult = {
    allowed: true,
    limit: 60,
    remaining: 59,
    resetAtMs: TEST_NOW.getTime() + 1_000,
  };
  failure: Error | undefined;

  constructor(order: string[] = []) {
    this.order = order;
  }

  async consume(input: Parameters<RateLimiter['consume']>[0]): Promise<RateLimitResult> {
    this.order.push('rate');
    this.calls.push(input);
    if (this.failure) throw this.failure;
    return this.result;
  }
}

type MemoryEntry = {
  readonly requestHash: string;
  state: 'in_progress' | 'completed';
  lockedUntil: Date;
  expiresAt: Date;
  response: { readonly status: number; readonly body: unknown } | undefined;
};

export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, MemoryEntry>();

  private key(userId: string, idempotencyKey: string): string {
    return JSON.stringify([userId, idempotencyKey]);
  }

  async acquire(
    input: Parameters<IdempotencyStore['acquire']>[0],
  ): Promise<IdempotencyAcquireResult> {
    const key = this.key(input.userId, input.key);
    const current = this.entries.get(key);
    if (
      current?.expiresAt.getTime() !== undefined &&
      current.expiresAt.getTime() <= input.now.getTime()
    ) {
      this.entries.delete(key);
    }
    const existing = this.entries.get(key);
    if (!existing) {
      this.entries.set(key, {
        requestHash: input.requestHash,
        state: 'in_progress',
        lockedUntil: input.leaseUntil,
        expiresAt: input.expiresAt,
        response: undefined,
      });
      return { kind: 'acquired', leaseUntil: input.leaseUntil };
    }
    if (existing.requestHash !== input.requestHash) return { kind: 'key_reused' };
    if (existing.state === 'completed') {
      if (!existing.response)
        throw new Error('Completed in-memory idempotency row has no response.');
      return { kind: 'completed', response: existing.response };
    }
    if (existing.lockedUntil.getTime() > input.now.getTime()) return { kind: 'in_progress' };
    existing.lockedUntil = input.leaseUntil;
    return { kind: 'acquired', leaseUntil: input.leaseUntil };
  }

  async complete(input: Parameters<IdempotencyStore['complete']>[0]): Promise<void> {
    const entry = this.entries.get(this.key(input.userId, input.key));
    if (
      !entry ||
      entry.state !== 'in_progress' ||
      entry.requestHash !== input.requestHash ||
      entry.lockedUntil.getTime() !== input.leaseUntil.getTime()
    ) {
      throw new Error('Idempotency lease is not owned by this request.');
    }
    entry.state = 'completed';
    entry.response = input.response;
  }

  async release(input: Parameters<IdempotencyStore['release']>[0]): Promise<void> {
    const key = this.key(input.userId, input.key);
    const entry = this.entries.get(key);
    if (
      entry?.state === 'in_progress' &&
      entry.requestHash === input.requestHash &&
      entry.lockedUntil.getTime() === input.leaseUntil.getTime()
    )
      this.entries.delete(key);
  }
}

export type TestRouteDependencies = {
  readonly dependencies: RouteDependencies;
  readonly logs: CapturedLog[];
  readonly auditEvents: Parameters<RouteDependencies['recordSecurityEvent']>[0][];
  readonly order: string[];
  readonly rateLimiter: RecordingRateLimiter;
  readonly idempotencyStore: MemoryIdempotencyStore;
};

export function createTestRouteDependencies(
  input: {
    readonly users?: Readonly<Record<string, string>>;
    readonly policies?: ReadonlyMap<
      string,
      { readonly policy: AuthorizationPolicy; readonly operator: boolean }
    >;
    readonly overrides?: Partial<RouteDependencies>;
  } = {},
): TestRouteDependencies {
  const logs: CapturedLog[] = [];
  const auditEvents: Parameters<RouteDependencies['recordSecurityEvent']>[0][] = [];
  const order: string[] = [];
  const rateLimiter = new RecordingRateLimiter(order);
  const idempotencyStore = new MemoryIdempotencyStore();
  const logger: AppLogger = {
    info(message, fields) {
      logs.push({ level: 'info', fields, message });
    },
    warn(message, fields) {
      logs.push({ level: 'warn', fields, message });
    },
    error(message, fields) {
      logs.push({ level: 'error', fields, message });
    },
  };
  const base: RouteDependencies = {
    now: () => new Date(TEST_NOW),
    requestId: () => TEST_REQUEST_ID,
    recentAuthMaxAgeSec: 300,
    logger,
    rateLimiter,
    idempotencyStore,
    async authenticateUser(token): Promise<AuthVerificationResult> {
      order.push('auth');
      const userId = input.users?.[token] ?? TEST_USER_A;
      return { ok: true, value: createTestUserAuthContext(userId) };
    },
    async checkVersionAndMaintenance() {
      order.push('gate');
      return { allow: true };
    },
    authorizationPolicies: input.policies ?? new Map(),
    async loadFreshRoles() {
      return [];
    },
    async recordSecurityEvent(event) {
      auditEvents.push(event);
    },
  };
  return {
    dependencies: { ...base, ...input.overrides },
    logs,
    auditEvents,
    order,
    rateLimiter,
    idempotencyStore,
  };
}
