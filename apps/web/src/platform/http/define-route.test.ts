import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import type {
  IdempotencyAcquireResult,
  IdempotencyStore,
  RateLimitConfig,
  RouteDependencies,
} from './types';
import { createDefineRoute } from './define-route';
import {
  createTestRouteDependencies,
  TEST_IDEMPOTENCY_KEY,
  TEST_NOW,
  TEST_REQUEST_ID,
  TEST_USER_A,
  TEST_USER_B,
} from '../testing/route-dependencies';

const ipLimit = { key: 'ip', limit: 60, windowSec: 60, onStoreFailure: 'closed' } as const;
const userRateLimit = {
  key: 'user',
  limit: 30,
  windowSec: 60,
  ipLimit: 120,
  onStoreFailure: 'closed',
} as const;
const outputSchema = z.strictObject({ ok: z.boolean() });

function publicRoute(
  dependencies: RouteDependencies,
  rateLimit: RateLimitConfig = ipLimit,
  handler: () => Promise<{ ok: boolean }> | { ok: boolean } = () => ({ ok: true }),
) {
  return createDefineRoute(dependencies)({
    operationId: 'getPublicTest',
    auth: { kind: 'public' },
    rateLimit,
    output: outputSchema,
    handler,
  });
}

function userRequest(token = 'test-token', headers: HeadersInit = {}): Request {
  return new Request('https://app.example/api/v1/test', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-real-ip': '198.51.100.12',
      ...headers,
    },
    body: JSON.stringify({ value: 'accepted' }),
  });
}

describe('defineRoute HTTP pipeline', () => {
  it('runs gate, authentication, rate limit, authorization, validation, and handler in order', async () => {
    const test = createTestRouteDependencies({
      policies: new Map([
        [
          'operator',
          {
            operator: true,
            policy: async () => {
              test.order.push('authorization');
              return { allow: true };
            },
          },
        ],
      ]),
    });
    const bodySchema = z.string().superRefine(() => test.order.push('validation'));
    const route = createDefineRoute(test.dependencies)({
      operationId: 'postProtectedTest',
      auth: { kind: 'user', requireRecentAuth: true },
      rateLimit: userRateLimit,
      authorize: ['operator'],
      input: { body: bodySchema },
      output: outputSchema,
      handler: async () => {
        test.order.push('handler');
        return { ok: true };
      },
    });
    const response = await route(
      new Request('https://app.example/api/v1/test', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
          'x-real-ip': '198.51.100.12',
        },
        body: JSON.stringify('accepted'),
      }),
    );
    expect(response.status).toBe(200);
    expect(test.order).toEqual([
      'gate',
      'auth',
      'rate',
      'rate',
      'authorization',
      'validation',
      'handler',
    ]);
  });

  it('uses a server-generated correlation ID and retains a valid client ID separately', async () => {
    const test = createTestRouteDependencies();
    let context:
      | {
          readonly correlationId: string;
          readonly requestId: string;
          readonly clientRequestId: string | null;
        }
      | undefined;
    const route = createDefineRoute(test.dependencies)({
      operationId: 'getCorrelationTest',
      auth: { kind: 'public' },
      rateLimit: ipLimit,
      output: outputSchema,
      handler: (value) => {
        context = value;
        return { ok: true };
      },
    });
    const response = await route(
      new Request('https://app.example/api/v1/test', {
        headers: { 'x-request-id': '99999999-9999-4999-8999-999999999999' },
      }),
    );
    expect(context).toEqual({
      requestId: TEST_REQUEST_ID,
      correlationId: TEST_REQUEST_ID,
      clientRequestId: '99999999-9999-4999-8999-999999999999',
      request: expect.any(Request),
      auth: null,
      input: { body: undefined, query: undefined, headers: undefined },
      now: expect.any(Date),
      host: 'app.example',
    });
    expect(response.headers.get('x-request-id')).toBe(TEST_REQUEST_ID);
  });

  it('shares the route IP bucket across authenticated users at the same IP', async () => {
    const test = createTestRouteDependencies({
      users: { tokenA: TEST_USER_A, tokenB: TEST_USER_B },
    });
    const route = createDefineRoute(test.dependencies)({
      operationId: 'postSharedIpTest',
      auth: { kind: 'user' },
      rateLimit: userRateLimit,
      output: outputSchema,
      handler: async () => ({ ok: true }),
    });
    await route(userRequest('tokenA'));
    await route(userRequest('tokenB'));
    const ipBuckets = test.rateLimiter.calls.filter(
      (call) => call.bucket === 'postSharedIpTest:ip:198.51.100.12',
    );
    const userBuckets = test.rateLimiter.calls.filter((call) => call.bucket.includes(':user:'));
    expect(ipBuckets).toHaveLength(2);
    expect(ipBuckets[0]?.bucket).toBe(ipBuckets[1]?.bucket);
    expect(userBuckets[0]?.bucket).not.toBe(userBuckets[1]?.bucket);
  });

  it('uses one global bucket for every caller on the route', async () => {
    const test = createTestRouteDependencies({
      users: { tokenA: TEST_USER_A, tokenB: TEST_USER_B },
    });
    const route = createDefineRoute(test.dependencies)({
      operationId: 'postGlobalTest',
      auth: { kind: 'user' },
      rateLimit: {
        key: 'global',
        limit: 10,
        windowSec: 60,
        ipLimit: 120,
        onStoreFailure: 'closed',
      },
      output: outputSchema,
      handler: async () => ({ ok: true }),
    });
    await route(userRequest('tokenA'));
    await route(userRequest('tokenB'));
    const globalBuckets = test.rateLimiter.calls.filter(
      (call) => call.bucket === 'postGlobalTest:global',
    );
    expect(globalBuckets).toHaveLength(2);
  });

  it('returns 429 with Retry-After and problem+json without an error stack', async () => {
    const test = createTestRouteDependencies();
    test.rateLimiter.result = {
      allowed: false,
      limit: 60,
      remaining: 0,
      resetAtMs: test.dependencies.now().getTime() + 4_100,
    };
    const route = publicRoute(test.dependencies);
    const response = await route(new Request('https://app.example/'));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('5');
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    const body = await response.text();
    expect(body).not.toContain('stack');
    expect(body).toContain('ratelimit.exceeded');
  });

  it('fails open only when the route declares it and marks the response', async () => {
    const open = createTestRouteDependencies();
    open.rateLimiter.failure = new Error('generated-test-only-store-error');
    const openRoute = publicRoute(open.dependencies, {
      key: 'ip',
      limit: 60,
      windowSec: 60,
      onStoreFailure: 'open',
    });
    const openResponse = await openRoute(new Request('https://app.example/'));
    expect(openResponse.status).toBe(200);
    expect(openResponse.headers.get('x-rate-limit-failure')).toBe('open');

    const closed = createTestRouteDependencies();
    closed.rateLimiter.failure = new Error('generated-test-only-store-error');
    const closedResponse = await publicRoute(closed.dependencies)(
      new Request('https://app.example/'),
    );
    expect(closedResponse.status).toBe(503);
  });

  it('rejects body limits above 1 MB and returns 413 for an oversized route body', async () => {
    const test = createTestRouteDependencies();
    expect(() =>
      createDefineRoute(test.dependencies)({
        operationId: 'postInvalidLimit',
        auth: { kind: 'public' },
        rateLimit: ipLimit,
        maxBodyBytes: 1_048_577,
        output: outputSchema,
        handler: async () => ({ ok: true }),
      }),
    ).toThrow(/maxBodyBytes/);

    const route = createDefineRoute(test.dependencies)({
      operationId: 'postSmallLimit',
      auth: { kind: 'public' },
      rateLimit: ipLimit,
      maxBodyBytes: 4,
      input: { body: z.string() },
      output: outputSchema,
      handler: async () => ({ ok: true }),
    });
    const response = await route(
      new Request('https://app.example/', { method: 'POST', body: '123456' }),
    );
    expect(response.status).toBe(413);
  });

  it('returns generic 500 and logs only driver name and code', async () => {
    const test = createTestRouteDependencies();
    const route = publicRoute(test.dependencies, ipLimit, async () => {
      throw Object.assign(new Error('generated-test-only-db-message'), { code: '23505' });
    });
    const response = await route(new Request('https://app.example/'));
    const body = await response.text();
    const logs = JSON.stringify(test.logs);
    expect(response.status).toBe(500);
    expect(body).not.toContain('generated-test-only-db-message');
    expect(body).not.toContain('23505');
    expect(logs).not.toContain('generated-test-only-db-message');
    expect(logs).toContain('23505');
  });

  it('turns a thrown authorization policy into fail-closed 403 and records a security event', async () => {
    const test = createTestRouteDependencies({
      policies: new Map([
        [
          'operator',
          {
            operator: true,
            policy: async () => {
              throw new Error('generated-test-only-policy-error');
            },
          },
        ],
      ]),
    });
    const route = createDefineRoute(test.dependencies)({
      operationId: 'postAuthorizationTest',
      auth: { kind: 'user' },
      rateLimit: userRateLimit,
      authorize: ['operator'],
      output: outputSchema,
      handler: async () => ({ ok: true }),
    });
    const response = await route(userRequest());
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('generated-test-only-policy-error');
    expect(test.auditEvents).toHaveLength(1);
    expect(test.auditEvents[0]?.action).toBe('security.authorization_policy_error');
  });

  it('uses the trusted non-default recent-auth window, the newest AMR timestamp and canonical error code', async () => {
    const freshAtBoundary = createTestRouteDependencies({
      overrides: {
        recentAuthMaxAgeSec: 60,
        async authenticateUser() {
          return {
            kind: 'user',
            userId: TEST_USER_A,
            isAnonymous: false,
            appRoles: [],
            providers: ['email'],
            amr: [
              { timestamp: TEST_NOW.getTime() / 1_000 - 600 },
              { timestamp: TEST_NOW.getTime() / 1_000 - 60 },
            ],
          };
        },
      },
    });
    const route = createDefineRoute(freshAtBoundary.dependencies)({
      operationId: 'getRecentAuthTest',
      auth: { kind: 'user', requireRecentAuth: true },
      rateLimit: userRateLimit,
      output: outputSchema,
      handler: async () => ({ ok: true }),
    });
    const request = () =>
      new Request('https://app.example/api/v1/test', {
        headers: { Authorization: 'Bearer test-token', 'x-real-ip': '198.51.100.12' },
      });
    await expect(
      freshAtBoundary.dependencies.authenticateUser('test-token', request()),
    ).resolves.toMatchObject({
      kind: 'user',
      userId: TEST_USER_A,
    });
    const freshResponse = await route(request());
    expect(freshResponse.status, JSON.stringify(await freshResponse.clone().json())).toBe(200);

    const stale = createTestRouteDependencies({
      overrides: {
        recentAuthMaxAgeSec: 60,
        async authenticateUser() {
          return {
            kind: 'user',
            userId: TEST_USER_A,
            isAnonymous: false,
            appRoles: [],
            providers: ['email'],
            amr: [{ timestamp: TEST_NOW.getTime() / 1_000 - 61 }],
          };
        },
      },
    });
    const staleResponse = await createDefineRoute(stale.dependencies)({
      operationId: 'getRecentAuthStaleTest',
      auth: { kind: 'user', requireRecentAuth: true },
      rateLimit: userRateLimit,
      output: outputSchema,
      handler: async () => ({ ok: true }),
    })(
      new Request('https://app.example/api/v1/test', {
        headers: {
          Authorization: 'Bearer test-token',
          'x-real-ip': '198.51.100.12',
          'x-recent-auth-max-age': '900',
        },
      }),
    );
    expect(staleResponse.status).toBe(401);
    expect((await staleResponse.json()).code).toBe('auth.recent_auth_required');
  });

  it('rejects an empty AMR and invalid trusted recent-auth configuration', async () => {
    const test = createTestRouteDependencies({
      overrides: {
        recentAuthMaxAgeSec: 900,
        async authenticateUser() {
          return {
            kind: 'user',
            userId: TEST_USER_A,
            isAnonymous: false,
            appRoles: [],
            providers: ['email'],
            amr: [],
          };
        },
      },
    });
    expect(() =>
      createDefineRoute({ ...test.dependencies, recentAuthMaxAgeSec: 59 })({
        operationId: 'getInvalidRecentAuthConfig',
        auth: { kind: 'public' },
        rateLimit: ipLimit,
        output: outputSchema,
        handler: async () => ({ ok: true }),
      }),
    ).toThrow(/between 60 and 900/);

    const route = createDefineRoute(test.dependencies)({
      operationId: 'getEmptyAmrTest',
      auth: { kind: 'user', requireRecentAuth: true },
      rateLimit: userRateLimit,
      output: outputSchema,
      handler: async () => ({ ok: true }),
    });
    const response = await route(
      new Request('https://app.example/', { headers: { Authorization: 'Bearer test-token' } }),
    );
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe('auth.recent_auth_required');
  });

  it('rejects maintenance exemption for ordinary user routes and allows a registered operator policy', () => {
    const ordinary = createTestRouteDependencies();
    expect(() =>
      createDefineRoute(ordinary.dependencies)({
        operationId: 'postNoExemption',
        auth: { kind: 'user' },
        rateLimit: userRateLimit,
        maintenance: 'exempt',
        output: outputSchema,
        handler: async () => ({ ok: true }),
      }),
    ).toThrow(/operator authorization policy/);

    const operator = createTestRouteDependencies({
      policies: new Map([
        ['operator', { operator: true, policy: async () => ({ allow: true as const }) }],
      ]),
    });
    expect(() =>
      createDefineRoute(operator.dependencies)({
        operationId: 'postOperatorExemption',
        auth: { kind: 'user' },
        rateLimit: userRateLimit,
        authorize: ['operator'],
        maintenance: 'exempt',
        output: outputSchema,
        handler: async () => ({ ok: true }),
      }),
    ).not.toThrow();
  });

  it('replays a completed idempotency key without calling the handler twice', async () => {
    const test = createTestRouteDependencies();
    let handlerCalls = 0;
    const route = createDefineRoute(test.dependencies)({
      operationId: 'postIdempotentTest',
      auth: { kind: 'user' },
      rateLimit: userRateLimit,
      input: { body: z.strictObject({ value: z.string() }) },
      idempotency: 'required',
      output: z.strictObject({ result: z.string() }),
      handler: async () => {
        handlerCalls += 1;
        return { result: 'saved' };
      },
    });
    const request = () =>
      new Request('https://app.example/api/v1/test', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': TEST_IDEMPOTENCY_KEY,
          'x-real-ip': '198.51.100.12',
        },
        body: JSON.stringify({ value: 'same' }),
      });

    const first = await route(request());
    const replay = await route(request());
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual({ result: 'saved' });
    expect(handlerCalls).toBe(1);
  });

  it.each([
    ['in_progress', 'idempotency.in_progress'],
    ['key_reused', 'idempotency.key_reused'],
  ] as const)('maps an idempotency %s claim to 409', async (kind, expectedCode) => {
    const test = createTestRouteDependencies();
    const store: IdempotencyStore = {
      async acquire(): Promise<IdempotencyAcquireResult> {
        return kind === 'in_progress' ? { kind: 'in_progress' } : { kind: 'key_reused' };
      },
      async complete() {},
      async release() {},
    };
    const dependencies: RouteDependencies = { ...test.dependencies, idempotencyStore: store };
    let handlerCalls = 0;
    const route = createDefineRoute(dependencies)({
      operationId: 'postIdempotencyConflictTest',
      auth: { kind: 'user' },
      rateLimit: userRateLimit,
      input: { body: z.strictObject({ value: z.string() }) },
      idempotency: 'required',
      output: outputSchema,
      handler: async () => {
        handlerCalls += 1;
        return { ok: true };
      },
    });
    const response = await route(
      userRequest('test-token', { 'Idempotency-Key': TEST_IDEMPOTENCY_KEY }),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe(expectedCode);
    expect(handlerCalls).toBe(0);
  });

  it('runs gates before auth, and webhook IP limiting before signature verification', async () => {
    const test = createTestRouteDependencies();
    const route = createDefineRoute(test.dependencies)({
      operationId: 'postWebhookOrderTest',
      auth: {
        kind: 'webhook',
        provider: 'provider',
        verifier: async () => {
          test.order.push('signature');
          return false;
        },
      },
      rateLimit: { key: 'global', limit: 10, windowSec: 60, ipLimit: 5, onStoreFailure: 'closed' },
      input: { body: z.unknown() },
      output: outputSchema,
      handler: async () => ({ ok: true }),
    });
    const response = await route(
      new Request('https://app.example/', {
        method: 'POST',
        body: JSON.stringify({ value: 'test' }),
      }),
    );
    expect(response.status).toBe(401);
    expect(test.order).toEqual(['gate', 'rate', 'signature']);
  });
});
