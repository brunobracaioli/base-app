import { parseServerEnv } from '../env';
import { createLogger } from '../observability/logger';
import { createUpstashDeletedAccountMarkerReader } from './deleted-marker';
import { createAuthVerifier, type AuthVerifier } from './verifier';
import type { AuthVerificationResult } from './types';

let defaultVerifier: AuthVerifier | undefined;

function createDefaultVerifier(): AuthVerifier {
  const logger = createLogger();
  try {
    const environment = parseServerEnv();
    const deletedAccountMarkerReader =
      environment.UPSTASH_REDIS_REST_URL && environment.UPSTASH_REDIS_REST_TOKEN
        ? createUpstashDeletedAccountMarkerReader({
            url: environment.UPSTASH_REDIS_REST_URL,
            token: environment.UPSTASH_REDIS_REST_TOKEN,
          })
        : {
            async isDeleted(): Promise<boolean> {
              throw new Error('Auth marker store is unavailable.');
            },
          };

    return createAuthVerifier({
      supabaseUrl: environment.SUPABASE_URL,
      deletedAccountMarkerReader,
      logger,
    });
  } catch {
    return createAuthVerifier({
      supabaseUrl: undefined,
      deletedAccountMarkerReader: {
        async isDeleted(): Promise<boolean> {
          throw new Error('Auth configuration is unavailable.');
        },
      },
      logger,
    });
  }
}

export function verifyAccessToken(token: string): Promise<AuthVerificationResult> {
  defaultVerifier ??= createDefaultVerifier();
  return defaultVerifier.verifyAccessToken(token);
}
