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
  createTestUserAuthContext,
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

function authenticatedRequest(token = 'test-token'): Request {
  return new Request('https://app.example/api/v1/test', {
    headers: {
      Authorization: `Bearer ${token}`,
      'x-real-ip': '198.51.100.12',
    },
  });
}

describe('defineRoute HTTP pipeline', () => {
  it('uses the app-config public cache only for successful public app-config responses', async () => {
    const test = createTestRouteDependencies();
    test.rateLimiter.failure = new Error('secret-bearing Redis response');
    const route = createDefineRoute(test.dependencies)({
      operationId: 'getAppConfig',
      auth: { kind: 'public' },
      rateLimit: { key: 'ip', limit: 60, windowSec: 60, onStoreFailure: 'open' },
      cachePolicy: 'public-app-config',
      output: outputSchema,
      handler: () => ({ ok: true }),
    });
    const response = await route(new Request('https://app.example/api/v1/app-config'));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(
      'public, s-maxage=60, stale-while-revalidate=60',
    );
    expect(response.headers.get('x-rate-limit-failure')).toBe('open');
    expect(test.logs.map(({ fields }) => JSON.stringify(fields)).join(' ')).not.toContain(
      'secret-bearing Redis response',
    );
  });

  it('rejects public app-config caching on private or unrelated routes', () => {
    const test = createTestRouteDependencies();
    expect(() =>
      createDefineRoute(test.dependencies)({
        operationId: 'getMe',
        auth: { kind: 'user' },
        rateLimit: userRateLimit,
        cachePolicy: 'public-app-config',
        output: outputSchema,
        handler: () => ({ ok: true }),
      }),
    ).toThrow(/restricted to its public 200 route/);
    expect(() =>
      createDefineRoute(test.dependencies)({
        operationId: 'getPublicTest',
        auth: { kind: 'public' },
        rateLimit: ipLimit,
        cachePolicy: 'public-app-config',
        output: outputSchema,
        handler: () => ({ ok: true }),
      }),
    ).toThrow(/restricted to its public 200 route/);
  });

  it('returns maintenance and update gate problems before auth on every HTTP method', async () => {
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
      const test = createTestRouteDependencies({
        overrides: {
          async checkVersionAndMaintenance() {
            test.order.push('gate');
            return {
              allow: false,
              status: 503,
              code: 'app.maintenance',
              title: 'Service temporarily unavailable.',
              retryAfterSec: 60,
            };
          },
        },
      });
      const route = createDefineRoute(test.dependencies)({
        operationId: `block${method[0]}${method.slice(1).toLowerCase()}`,
        auth: { kind: 'user' },
        rateLimit: userRateLimit,
        output: outputSchema,
        handler: () => ({ ok: true }),
      });
      const response = await route(
        new Request('https://app.example/api/v1/me', { method }),
      );
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('60');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(test.order).toEqual(['gate']);
    }

    const outdated = createTestRouteDependencies({
      overrides: {
        async checkVersionAndMaintenance() {
          return {
            allow: false,
            status: 426,
            code: 'app.update_required',
            title: 'Update required.',
          };
        },
      },
    });
    const response = await createDefineRoute(outdated.dependencies)({
      operationId: 'getUpdateGateTest',
      auth: { kind: 'user' },
      rateLimit: userRateLimit,
      output: outputSchema,
      handler: () => ({ ok: true }),
    })(new Request('https://app.example/api/v1/me'));
    expect(response.status).toBe(426);
    expect(response.headers.get('retry-after')).toBeNull();
    expect((await response.json()).code).toBe('app.update_required');
  });

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

  it('logs completion with verified identity and safe correlation fields only', async () => {
    let rejectAuthentication = false;
    const test = createTestRouteDependencies({
      overrides: {
        async authenticateUser() {
          if (rejectAuthentication) {
            return { ok: false, error: { code: 'auth.invalid_token' } };
          }
          return {
            ok: true,
            value: {
              ...createTestUserAuthContext(TEST_USER_A),
              email: 'private-user@example.test',
            },
          };
        },
      },
    });
    const route = createDefineRoute(test.dependencies)({
      operationId: 'getCompletionLoggingTest',
      auth: { kind: 'user' },
      rateLimit: userRateLimit,
      output: outputSchema,
      handler: async () => ({ ok: true }),
    });
    const makeRequest = () =>
      new Request('https://app.example/api/v1/test', {
        headers: {
          Authorization: 'Bearer unlogged-auth-token',
          'x-real-ip': '198.51.100.12',
          'x-request-id': '99999999-9999-4999-8999-999999999999',
        },
      });

    const success = await route(makeRequest());
    expect(success.status).toBe(200);

    test.rateLimiter.result = {
      allowed: false,
      limit: 30,
      remaining: 0,
      resetAtMs: TEST_NOW.getTime() + 1_000,
    };
    const rejectedAfterAuthentication = await route(makeRequest());
    expect(rejectedAfterAuthentication.status).toBe(429);

    rejectAuthentication = true;
    const rejectedBeforeAuthentication = await route(makeRequest());
    expect(rejectedBeforeAuthentication.status).toBe(401);

    const completionLogs = test.logs.filter((entry) => entry.message === 'API request completed');
    expect(completionLogs).toHaveLength(3);
    expect(completionLogs[0]?.fields).toEqual({
      route: 'getCompletionLoggingTest',
      requestId: TEST_REQUEST_ID,
      clientRequestId: '99999999-9999-4999-8999-999999999999',
      outcome: 'success',
      userId: TEST_USER_A,
    });
    expect(completionLogs[1]?.fields).toEqual({
      route: 'getCompletionLoggingTest',
      requestId: TEST_REQUEST_ID,
      clientRequestId: '99999999-9999-4999-8999-999999999999',
      outcome: 'rejected',
      userId: TEST_USER_A,
    });
    expect(completionLogs[2]?.fields).toEqual({
      route: 'getCompletionLoggingTest',
      requestId: TEST_REQUEST_ID,
      clientRequestId: '99999999-9999-4999-8999-999999999999',
      outcome: 'rejected',
    });
    const serializedLogs = JSON.stringify(completionLogs);
    expect(serializedLogs).not.toContain('unlogged-auth-token');
    expect(serializedLogs).not.toContain('private-user@example.test');
    expect(serializedLogs).not.toContain('198.51.100.12');
  });

  it('does not let a completion log sink failure alter the route response or recurse', async () => {
    const test = createTestRouteDependencies();
    const dependencies: RouteDependencies = {
      ...test.dependencies,
      logger: {
        info() {
          throw new Error('completion log sink unavailable');
        },
        warn() {},
        error() {},
      },
    };
    const route = createDefineRoute(dependencies)({
      operationId: 'getCompletionLogFailureTest',
      auth: { kind: 'public' },
      rateLimit: ipLimit,
      output: outputSchema,
      handler: async () => ({ ok: true }),
    });

    const response = await route(new Request('https://app.example/'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(test.logs).toEqual([]);
  });

  it('keeps the health route exempt from completion logs', async () => {
    const test = createTestRouteDependencies();
    const route = createDefineRoute(test.dependencies)({
      operationId: 'getHealth',
      auth: { kind: 'public' },
      rateLimit: ipLimit,
      output: outputSchema,
      handler: async () => ({ ok: true }),
    });

    const response = await route(new Request('https://app.example/'));

    expect(response.status).toBe(200);
    expect(test.logs).toEqual([]);
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

  it.each([
    ['auth.invalid_token', 401, undefined],
    ['auth.token_expired', 401, undefined],
    ['auth.account_deleted', 401, undefined],
    ['auth.unavailable', 503, 13],
  ] as const)(
    'preserves authentication failure %s as HTTP %s',
    async (code, status, retryAfter) => {
      const test = createTestRouteDependencies({
        overrides: {
          async authenticateUser() {
            return {
              ok: false,
              error: { code, ...(retryAfter === undefined ? {} : { retryAfterSec: retryAfter }) },
            };
          },
        },
      });
      const route = createDefineRoute(test.dependencies)({
        operationId: 'getAuthFailureTest',
        auth: { kind: 'user' },
        rateLimit: userRateLimit,
        output: outputSchema,
        handler: async () => ({ ok: true }),
      });
      const response = await route(userRequest('sensitive-test-token'));
      expect(response.status).toBe(status);
      expect((await response.json()).code).toBe(code);
      expect(response.headers.get('retry-after')).toBe(status === 503 ? '13' : null);
      expect(JSON.stringify(test.logs)).not.toContain('sensitive-test-token');
    },
  );

  it('distinguishes a missing Authorization header from a malformed bearer value', async () => {
    const test = createTestRouteDependencies();
    const route = createDefineRoute(test.dependencies)({
      operationId: 'getMissingAuthTest',
      auth: { kind: 'user' },
      rateLimit: userRateLimit,
      output: outputSchema,
      handler: async () => ({ ok: true }),
    });

    const missing = await route(new Request('https://app.example/'));
    expect(missing.status).toBe(401);
    expect((await missing.json()).code).toBe('auth.missing_token');

    const malformed = await route(
      new Request('https://app.example/', { headers: { Authorization: 'Basic hidden-value' } }),
    );
    expect(malformed.status).toBe(401);
    expect((await malformed.json()).code).toBe('auth.invalid_token');
    expect(JSON.stringify(test.logs)).not.toContain('hidden-value');
  });

  it('fails a thrown verifier closed as unavailable without exposing its message or token', async () => {
    const test = createTestRouteDependencies({
      overrides: {
        async authenticateUser() {
          throw new Error('private jwks response with sensitive-test-token');
        },
      },
    });
    const route = createDefineRoute(test.dependencies)({
      operationId: 'getThrownAuthVerifierTest',
      auth: { kind: 'user' },
      rateLimit: userRateLimit,
      output: outputSchema,
      handler: async () => ({ ok: true }),
    });

    const response = await route(userRequest('sensitive-test-token'));
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('auth.unavailable');
    expect(response.headers.get('retry-after')).toBe('5');
    expect(JSON.stringify(test.logs)).not.toContain('private jwks response');
    expect(JSON.stringify(test.logs)).not.toContain('sensitive-test-token');
  });

  it('returns an empty secured 204 response and validates its undefined output in production mode', async () => {
    const test = createTestRouteDependencies();
    const route = createDefineRoute(test.dependencies)({
      operationId: 'postNoContentTest',
      auth: { kind: 'user' },
      rateLimit: userRateLimit,
      successStatus: 204,
      output: z.undefined(),
      handler: async () => undefined,
    });
    const previousNodeEnvironment = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const response = await (async () => {
      try {
        return await route(authenticatedRequest());
      } finally {
        if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousNodeEnvironment;
      }
    })();

    expect(response.status).toBe(204);
    await expect(response.text()).resolves.toBe('');
    expect(response.headers.get('content-type')).toBeNull();
    expect(response.headers.get('x-request-id')).toBe(TEST_REQUEST_ID);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('strict-transport-security')).toBeTruthy();
    expect(response.headers.get('content-security-policy')).toBeTruthy();
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
    const response = await route(authenticatedRequest());
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('generated-test-only-policy-error');
    expect(test.auditEvents).toHaveLength(1);
    expect(test.auditEvents[0]?.action).toBe('security.authorization_policy_error');
  });

  it('passes the complete verified user context to fresh-role loading', async () => {
    let loadedContext: ReturnType<typeof createTestUserAuthContext> | undefined;
    const test = createTestRouteDependencies({
      policies: new Map([
        [
          'fresh-role-reader',
          {
            operator: false,
            policy: async (request) => {
              await request.loadFreshRoles();
              return { allow: true };
            },
          },
        ],
      ]),
      overrides: {
        async loadFreshRoles(auth) {
          loadedContext = auth;
          return [];
        },
      },
    });
    const route = createDefineRoute(test.dependencies)({
      operationId: 'getFreshRolesContextTest',
      auth: { kind: 'user' },
      rateLimit: userRateLimit,
      authorize: ['fresh-role-reader'],
      output: outputSchema,
      handler: async () => ({ ok: true }),
    });

    const response = await route(authenticatedRequest());
    expect(response.status).toBe(200);
    expect(loadedContext).toMatchObject({
      kind: 'user',
      userId: TEST_USER_A,
      sessionId: expect.any(String),
      aal: 'aal1',
      email: null,
      dbClaims: {
        sub: TEST_USER_A,
        role: 'authenticated',
        aal: 'aal1',
        session_id: expect.any(String),
      },
    });
  });

  it('uses the trusted non-default recent-auth window, the newest AMR timestamp and canonical error code', async () => {
    const freshAtBoundary = createTestRouteDependencies({
      overrides: {
        recentAuthMaxAgeSec: 60,
        async authenticateUser() {
          return {
            ok: true,
            value: createTestUserAuthContext(TEST_USER_A, [
              { method: 'email', timestamp: TEST_NOW.getTime() / 1_000 - 600 },
              { method: 'email', timestamp: TEST_NOW.getTime() / 1_000 - 60 },
            ]),
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
      ok: true,
      value: { kind: 'user', userId: TEST_USER_A },
    });
    const freshResponse = await route(request());
    expect(freshResponse.status, JSON.stringify(await freshResponse.clone().json())).toBe(200);

    const stale = createTestRouteDependencies({
      overrides: {
        recentAuthMaxAgeSec: 60,
        async authenticateUser() {
          return {
            ok: true,
            value: createTestUserAuthContext(TEST_USER_A, [
              { method: 'email', timestamp: TEST_NOW.getTime() / 1_000 - 61 },
            ]),
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
          return { ok: true, value: createTestUserAuthContext(TEST_USER_A, []) };
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

  it('replays a completed 204 response with the original bodyless status', async () => {
    const test = createTestRouteDependencies();
    let handlerCalls = 0;
    const route = createDefineRoute(test.dependencies)({
      operationId: 'postIdempotentNoContentTest',
      auth: { kind: 'user' },
      rateLimit: userRateLimit,
      input: { body: z.strictObject({ value: z.string() }) },
      idempotency: 'required',
      successStatus: 204,
      output: z.undefined(),
      handler: async () => {
        handlerCalls += 1;
        return undefined;
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
    expect(first.status).toBe(204);
    expect(replay.status).toBe(204);
    await expect(replay.text()).resolves.toBe('');
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
