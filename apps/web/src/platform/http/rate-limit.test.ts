import { describe, expect, it } from 'vitest';
import type { Redis } from '@upstash/redis';

import { createDefineRoute } from './define-route';
import {
  RateLimitUnavailableError,
  UpstashRateLimiter,
  type UpstashLimiterFactory,
} from './rate-limit';
import { createTestRouteDependencies } from '../testing/route-dependencies';
import * as z from 'zod';

describe('Upstash rate-limit timeout behavior', () => {
  it('treats the SDK fail-open timeout result as a store failure', async () => {
    const fakeRedis = {} as Redis;
    const factory: UpstashLimiterFactory = ({ limit, windowSec }) => {
      expect(limit).toBe(60);
      expect(windowSec).toBe(60);
      return {
        async limit() {
          return {
            success: true,
            limit: 0,
            remaining: 0,
            reset: 0,
            reason: 'timeout',
          };
        },
      };
    };
    const limiter = new UpstashRateLimiter(fakeRedis, factory);
    await expect(
      limiter.consume({ bucket: 'getHealth:ip:198.51.100.10', limit: 60, windowSec: 60, nowMs: 0 }),
    ).rejects.toBeInstanceOf(RateLimitUnavailableError);
  });

  it.each([
    ['closed', 503, null],
    ['open', 200, 'open'],
  ] as const)(
    'routes a timeout through onStoreFailure=%s',
    async (failureMode, status, failureHeader) => {
      const test = createTestRouteDependencies();
      const factory: UpstashLimiterFactory = () => ({
        async limit() {
          return { success: true, limit: 0, remaining: 0, reset: 0, reason: 'timeout' };
        },
      });
      const limiter = new UpstashRateLimiter({} as Redis, factory);
      const route = createDefineRoute({ ...test.dependencies, rateLimiter: limiter })({
        operationId: 'getRateTimeoutTest',
        auth: { kind: 'public' },
        rateLimit: { key: 'ip', limit: 60, windowSec: 60, onStoreFailure: failureMode },
        output: z.strictObject({ ok: z.boolean() }),
        handler: async () => ({ ok: true }),
      });
      const response = await route(new Request('https://app.example/'));
      expect(response.status).toBe(status);
      expect(response.headers.get('x-rate-limit-failure')).toBe(failureHeader);
    },
  );
});
