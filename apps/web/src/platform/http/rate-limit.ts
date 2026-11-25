import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

export type RateLimitResult = {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly resetAtMs: number;
};

export interface RateLimiter {
  consume(input: {
    readonly bucket: string;
    readonly limit: number;
    readonly windowSec: number;
    readonly nowMs: number;
  }): Promise<RateLimitResult>;
}

export type UpstashLimitResult = {
  readonly success: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly reset: number;
  readonly reason?: 'timeout' | 'cacheBlock' | 'denyList';
};

export interface UpstashLimiterClient {
  limit(identifier: string): Promise<UpstashLimitResult>;
}

export type UpstashLimiterFactory = (input: {
  readonly redis: Redis;
  readonly limit: number;
  readonly windowSec: number;
}) => UpstashLimiterClient;

const UPSTASH_TIMEOUT_MS = 2_500;
const REDIS_REQUEST_TIMEOUT_MS = 3_000;

export class RateLimitUnavailableError extends Error {
  readonly code = 'ratelimit.unavailable';

  constructor() {
    super('Rate limit store is unavailable.');
    this.name = 'RateLimitUnavailableError';
  }
}

export class UnavailableRateLimiter implements RateLimiter {
  async consume(): Promise<RateLimitResult> {
    throw new RateLimitUnavailableError();
  }
}

export class UpstashRateLimiter implements RateLimiter {
  private readonly limiters = new Map<string, UpstashLimiterClient>();

  constructor(
    private readonly redis: Redis,
    private readonly createLimiter: UpstashLimiterFactory = ({ redis, limit, windowSec }) =>
      new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(limit, `${windowSec} s`),
        prefix: `base-app:rate:${limit}:${windowSec}`,
        analytics: false,
        timeout: UPSTASH_TIMEOUT_MS,
      }),
  ) {}

  async consume(input: {
    readonly bucket: string;
    readonly limit: number;
    readonly windowSec: number;
    readonly nowMs: number;
  }): Promise<RateLimitResult> {
    const key = `${input.limit}:${input.windowSec}`;
    let limiter = this.limiters.get(key);
    if (!limiter) {
      limiter = this.createLimiter({
        redis: this.redis,
        limit: input.limit,
        windowSec: input.windowSec,
      });
      this.limiters.set(key, limiter);
    }

    const result = await limiter.limit(input.bucket);
    if (result.reason === 'timeout') throw new RateLimitUnavailableError();
    return {
      allowed: result.success,
      limit: result.limit,
      remaining: result.remaining,
      resetAtMs: result.reset,
    };
  }
}

export function createUpstashRateLimiter(input: {
  readonly url: string;
  readonly token: string;
}): UpstashRateLimiter {
  const redis = new Redis({
    url: input.url,
    token: input.token,
    retry: false,
    signal: () => AbortSignal.timeout(REDIS_REQUEST_TIMEOUT_MS),
  });
  return new UpstashRateLimiter(redis);
}
