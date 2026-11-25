import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod';

import type { RouteDependencies } from './types';
import {
  TEST_NOW,
  TEST_REQUEST_ID,
  TEST_SESSION_ID,
  TEST_USER_A,
  TEST_USER_B,
} from '../testing/route-dependencies';

const SUPABASE_URL = 'https://project.supabase.co';
const ISSUER = `${SUPABASE_URL}/auth/v1`;

function encodeBase64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function testRequest(headerToken: string, secondToken: string): Request {
  return new Request('https://app.example/api/v1/fake/verify-second-token', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${headerToken}`,
      'Content-Type': 'application/json',
      'x-real-ip': '198.51.100.12',
    },
    body: JSON.stringify({ accessToken: secondToken }),
  });
}

describe('public access-token verifier through the protected route pipeline', () => {
  it('matches default authentication and verifies a second body token through the public facade', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(TEST_NOW);
    vi.resetModules();
    vi.stubEnv('APP_HOST', 'app.example');
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('LOG_LEVEL', 'silent');
    vi.stubEnv('SUPABASE_URL', SUPABASE_URL);
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.example.test');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'ephemeral-test-redis-token');

    const keyPair = await generateKeyPair('ES256');
    const publicJwk = {
      ...(await exportJWK(keyPair.publicKey)),
      kid: 'pipeline-key',
      alg: 'ES256',
      use: 'sig',
    };
    const deletedUsers = new Set<string>();
    const capturedLogs: string[] = [];
    vi.doMock('@upstash/redis', () => ({
      Redis: class {
        async exists(key: string): Promise<number> {
          const userId = key.split(':').at(-1);
          return userId && deletedUsers.has(userId) ? 1 : 0;
        }
      },
    }));
    vi.doMock('../observability/logger', () => ({
      createLogger: () => ({
        info(message: string, fields: Readonly<Record<string, unknown>>) {
          capturedLogs.push(JSON.stringify({ level: 'info', message, fields }));
        },
        warn(message: string, fields: Readonly<Record<string, unknown>>) {
          capturedLogs.push(JSON.stringify({ level: 'warn', message, fields }));
        },
        error(message: string, fields: Readonly<Record<string, unknown>>) {
          capturedLogs.push(JSON.stringify({ level: 'error', message, fields }));
        },
      }),
    }));
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ keys: [publicJwk] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );

    try {
      const [auth, runtime, http, problem] = await Promise.all([
        import('../auth'),
        import('./runtime'),
        import('./define-route'),
        import('./problem'),
      ]);
      const { verifyAccessToken } = auth;
      const { createDefaultRouteDependencies } = runtime;
      const { createDefineRoute } = http;
      const { HttpProblem } = problem;
      const nowSec = TEST_NOW.getTime() / 1_000;

      async function signToken(
        userId: string,
        expiresAt: number,
        issuedAt = nowSec,
      ): Promise<string> {
        return new SignJWT({
          session_id: TEST_SESSION_ID,
          role: 'authenticated',
          aal: 'aal1',
          amr: [{ method: 'email', timestamp: nowSec }],
          app_metadata: { roles: ['pro'], providers: ['email'] },
          user_metadata: { locale: 'en' },
        })
          .setProtectedHeader({ alg: 'ES256', kid: 'pipeline-key' })
          .setIssuer(ISSUER)
          .setAudience('authenticated')
          .setSubject(userId)
          .setIssuedAt(issuedAt)
          .setExpirationTime(expiresAt)
          .sign(keyPair.privateKey);
      }

      const headerToken = await signToken(TEST_USER_A, nowSec + 900);
      const validSecondToken = await signToken(TEST_USER_B, nowSec + 900);
      const expiredHeaderToken = await signToken(TEST_USER_A, nowSec - 31, nowSec - 900);
      const noAlgorithmToken = [
        encodeBase64Url({ alg: 'none', typ: 'JWT' }),
        encodeBase64Url({
          sub: TEST_USER_A,
          session_id: TEST_SESSION_ID,
          role: 'authenticated',
          aal: 'aal1',
          amr: [{ method: 'email', timestamp: nowSec }],
          exp: nowSec + 900,
          iat: nowSec,
          iss: ISSUER,
          aud: 'authenticated',
        }),
        '',
      ].join('.');

      const defaults = createDefaultRouteDependencies();
      const rateLimiter: RouteDependencies['rateLimiter'] = {
        async consume(input) {
          return {
            allowed: true,
            limit: input.limit,
            remaining: input.limit - 1,
            resetAtMs: input.nowMs + input.windowSec * 1_000,
          };
        },
      };
      const dependencies: RouteDependencies = {
        ...defaults,
        now: () => new Date(TEST_NOW),
        requestId: () => TEST_REQUEST_ID,
        rateLimiter,
      };
      const route = createDefineRoute(dependencies)({
        operationId: 'postSecondTokenVerificationTest',
        auth: { kind: 'user' },
        rateLimit: {
          key: 'user',
          limit: 20,
          windowSec: 60,
          ipLimit: 120,
          onStoreFailure: 'closed',
        },
        input: { body: z.strictObject({ accessToken: z.string().min(1) }) },
        output: z.strictObject({ userId: z.string().uuid() }),
        async handler(context) {
          const second = await verifyAccessToken(context.input.body.accessToken);
          if (!second.ok) {
            const status = second.error.code === 'auth.unavailable' ? 503 : 401;
            throw new HttpProblem(
              status,
              second.error.code,
              'Authentication failed.',
              status === 503
                ? { 'Retry-After': String(second.error.retryAfterSec ?? 3) }
                : undefined,
            );
          }
          return { userId: second.value.userId };
        },
      });

      const publicResult = await verifyAccessToken(headerToken);
      const defaultAuthentication = await defaults.authenticateUser(
        headerToken,
        new Request('https://app.example/api/v1/fake'),
      );
      expect(defaultAuthentication).toEqual(publicResult);
      expect(publicResult, JSON.stringify(publicResult)).toMatchObject({
        ok: true,
        value: { userId: TEST_USER_A },
      });
      expect(await verifyAccessToken(validSecondToken)).toMatchObject({
        ok: true,
        value: { userId: TEST_USER_B },
      });

      const validRouteResponse = await route(testRequest(headerToken, validSecondToken));
      expect(validRouteResponse.status).toBe(200);
      await expect(validRouteResponse.json()).resolves.toEqual({ userId: TEST_USER_B });

      const initialCases = [
        { token: noAlgorithmToken, code: 'auth.invalid_token' },
        { token: expiredHeaderToken, code: 'auth.token_expired' },
      ] as const;
      for (const failureCase of initialCases) {
        const direct = await verifyAccessToken(failureCase.token);
        const defaultResult = await defaults.authenticateUser(
          failureCase.token,
          new Request('https://app.example/api/v1/fake'),
        );
        expect(defaultResult).toEqual(direct);
        expect(direct).toMatchObject({ ok: false, error: { code: failureCase.code } });
        const response = await route(testRequest(failureCase.token, validSecondToken));
        expect(response.status).toBe(401);
        const responseBody = await response.text();
        expect(JSON.parse(responseBody).code).toBe(failureCase.code);
        expect(responseBody).not.toContain(failureCase.token);
        expect(responseBody).not.toContain(validSecondToken);
      }

      const invalidSecondDirect = await verifyAccessToken(noAlgorithmToken);
      expect(invalidSecondDirect).toMatchObject({
        ok: false,
        error: { code: 'auth.invalid_token' },
      });
      const invalidSecondResponse = await route(testRequest(headerToken, noAlgorithmToken));
      expect(invalidSecondResponse.status).toBe(401);
      const invalidSecondResponseBody = await invalidSecondResponse.text();
      expect(JSON.parse(invalidSecondResponseBody).code).toBe('auth.invalid_token');
      expect(invalidSecondResponseBody).not.toContain(headerToken);
      expect(invalidSecondResponseBody).not.toContain(noAlgorithmToken);

      deletedUsers.add(TEST_USER_A);
      const deletedDirect = await verifyAccessToken(headerToken);
      const deletedDefaultResult = await defaults.authenticateUser(
        headerToken,
        new Request('https://app.example/api/v1/fake'),
      );
      expect(deletedDefaultResult).toEqual(deletedDirect);
      expect(deletedDirect).toEqual({
        ok: false,
        error: { code: 'auth.account_deleted' },
      });
      const deletedResponse = await route(testRequest(headerToken, validSecondToken));
      expect(deletedResponse.status).toBe(401);
      const deletedResponseBody = await deletedResponse.text();
      expect(JSON.parse(deletedResponseBody).code).toBe('auth.account_deleted');
      expect(deletedResponseBody).not.toContain(headerToken);
      expect(deletedResponseBody).not.toContain(validSecondToken);
      const logOutput = capturedLogs.join('\n');
      for (const token of [headerToken, validSecondToken, noAlgorithmToken, expiredHeaderToken]) {
        expect(logOutput).not.toContain(token);
      }
    } finally {
      vi.doUnmock('@upstash/redis');
      vi.doUnmock('../observability/logger');
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      vi.useRealTimers();
      vi.resetModules();
    }
  });
});
