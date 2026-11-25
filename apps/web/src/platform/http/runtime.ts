import { parseServerEnv } from '../env/index';
import { verifyAccessToken } from '../auth';
import { createLogger } from '../observability/logger';
import productConfig from '@base-app/config/product.config';
import { serverExtensionComposition } from '../composition/index';
import { createUuidV7 } from './request-id';
import {
  createUpstashRateLimiter,
  RateLimitUnavailableError,
  type RateLimiter,
  type RateLimitResult,
} from './rate-limit';
import type { IdempotencyStore, RouteDependencies } from './types';

class LazyEnvironmentRateLimiter implements RateLimiter {
  private delegate: RateLimiter | undefined;

  async consume(input: {
    readonly bucket: string;
    readonly limit: number;
    readonly windowSec: number;
    readonly nowMs: number;
  }): Promise<RateLimitResult> {
    if (!this.delegate) {
      const environment = parseServerEnv();
      if (!environment.UPSTASH_REDIS_REST_URL || !environment.UPSTASH_REDIS_REST_TOKEN) {
        throw new RateLimitUnavailableError();
      }
      this.delegate = createUpstashRateLimiter({
        url: environment.UPSTASH_REDIS_REST_URL,
        token: environment.UPSTASH_REDIS_REST_TOKEN,
      });
    }
    return this.delegate.consume(input);
  }
}

class UnavailableIdempotencyStore implements IdempotencyStore {
  private unavailable(): never {
    throw new Error('Idempotency storage is unavailable.');
  }

  async acquire(): Promise<never> {
    return this.unavailable();
  }

  async complete(): Promise<never> {
    return this.unavailable();
  }

  async release(): Promise<never> {
    return this.unavailable();
  }
}

export function createDefaultRouteDependencies(
  input: { readonly recentAuthMaxAgeSec?: number } = {},
): RouteDependencies {
  const logger = createLogger();
  return {
    now: () => new Date(),
    requestId: () => createUuidV7(),
    recentAuthMaxAgeSec: input.recentAuthMaxAgeSec ?? productConfig.auth.recentAuthMaxAgeSec,
    logger,
    rateLimiter: new LazyEnvironmentRateLimiter(),
    idempotencyStore: new UnavailableIdempotencyStore(),
    authenticateUser: async (token) => verifyAccessToken(token),
    checkVersionAndMaintenance: async (input) => {
      if (input.operationId === 'getHealth' || input.operationId === 'getAppConfig') {
        return { allow: true };
      }
      const { getSafeAppConfigRuntime } = await import('../composition/core');
      return getSafeAppConfigRuntime().checkAppConfigGate(input);
    },
    authorizationPolicies: serverExtensionComposition.authorizationPolicies,
    loadFreshRoles: async (auth) => {
      const { getCoreRuntime } = await import('../composition/core');
      return getCoreRuntime().loadFreshRoles(auth);
    },
    recordSecurityEvent: async () => {
      throw new Error('Security audit writer is unavailable.');
    },
  };
}
