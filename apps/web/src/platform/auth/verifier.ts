import { customFetch, createRemoteJWKSet, jwtVerify, type FetchImplementation } from 'jose';
import * as z from 'zod';

import productConfig from '@base-app/config/product.config';
import { parseUserDbClaims } from '../db/claims';
import type { AppLogger } from '../observability/logger';
import { storeProfileLocaleHint } from './profile-locale';
import type { AuthVerificationResult } from './types';

const MAX_ACCESS_TOKEN_LENGTH = 4_096;
const JWKS_CACHE_MAX_AGE_MS = 600_000;
const JWKS_COOLDOWN_MS = 60_000;
const JWKS_TIMEOUT_MS = 3_000;
const CLOCK_TOLERANCE_SEC = 30;
const UNAVAILABLE_RETRY_AFTER_SEC = 3;
const ROLE_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

const amrEntrySchema = z.object({
  method: z.string().min(1),
  timestamp: z.number().finite(),
});

const authClaimsSchema = z.object({
  sub: z.uuid(),
  session_id: z.uuid(),
  role: z.literal('authenticated'),
  aal: z.enum(['aal1', 'aal2']),
  amr: z.array(amrEntrySchema),
  exp: z.number().finite(),
  iat: z.number().finite(),
  email: z.email().optional(),
  is_anonymous: z.boolean().optional(),
  app_metadata: z.unknown().optional(),
  user_metadata: z.unknown().optional(),
});

const UNAVAILABLE_JWKS_CODES = new Set([
  'ERR_JOSE_GENERIC',
  'ERR_JOSE_NOT_SUPPORTED',
  'ERR_JWK_INVALID',
  'ERR_JWKS_INVALID',
  'ERR_JWKS_MULTIPLE_MATCHING_KEYS',
  'ERR_JWKS_TIMEOUT',
]);

export interface DeletedAccountMarkerReader {
  isDeleted(userId: string): Promise<boolean>;
}

export type AuthVerifierOptions = {
  readonly supabaseUrl: string | undefined;
  readonly deletedAccountMarkerReader: DeletedAccountMarkerReader;
  readonly logger: AppLogger;
  readonly now?: () => Date;
  readonly fetch?: FetchImplementation;
  readonly allowedLocales?: readonly string[];
};

export interface AuthVerifier {
  verifyAccessToken(token: string): Promise<AuthVerificationResult>;
}

class JwksFetchUnavailableError extends Error {
  constructor() {
    super('JWKS service is unavailable.');
    this.name = 'JwksFetchUnavailableError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readMetadataClaim(metadata: unknown, key: string): unknown {
  if (!isRecord(metadata)) return undefined;
  return metadata[key];
}

function readRoleList(
  value: unknown,
  claim: 'roles' | 'providers',
  logger: AppLogger,
): readonly string[] {
  if (value === undefined) return [];
  const result = z.array(z.string().regex(ROLE_PATTERN)).max(10).safeParse(value);
  if (result.success) return result.data;

  logger.warn('Auth metadata list was discarded', { claim, reason: 'invalid_list' });
  return [];
}

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function unavailable(logger: AppLogger, reason: 'jwks' | 'deleted_marker'): AuthVerificationResult {
  logger.error('Access token verification dependency is unavailable', { dependency: reason });
  return {
    ok: false,
    error: { code: 'auth.unavailable', retryAfterSec: UNAVAILABLE_RETRY_AFTER_SEC },
  };
}

function invalidToken(
  logger: AppLogger,
  reason: 'claims' | 'signature' | 'size',
): AuthVerificationResult {
  logger.warn('Access token was rejected', { reason });
  return { ok: false, error: { code: 'auth.invalid_token' } };
}

function normalizedSupabaseUrl(value: string): URL {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

export function createAuthVerifier(options: AuthVerifierOptions): AuthVerifier {
  const supabaseUrl = options.supabaseUrl ? normalizedSupabaseUrl(options.supabaseUrl) : undefined;
  const allowedLocales = new Set(options.allowedLocales ?? productConfig.locales);
  const now = options.now ?? (() => new Date());

  const jwks = supabaseUrl
    ? createRemoteJWKSet(new URL('/auth/v1/.well-known/jwks.json', supabaseUrl), {
        cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
        cooldownDuration: JWKS_COOLDOWN_MS,
        timeoutDuration: JWKS_TIMEOUT_MS,
        [customFetch]: async (url, init) => {
          try {
            return await (options.fetch ?? fetch)(url, init);
          } catch {
            throw new JwksFetchUnavailableError();
          }
        },
      })
    : undefined;

  async function verifyAccessToken(token: string): Promise<AuthVerificationResult> {
    if (token.length > MAX_ACCESS_TOKEN_LENGTH) return invalidToken(options.logger, 'size');
    if (!jwks || !supabaseUrl) return unavailable(options.logger, 'jwks');

    const currentDate = now();
    let rawPayload: unknown;
    try {
      const verified = await jwtVerify(token, jwks, {
        algorithms: ['ES256', 'RS256'],
        issuer: new URL('/auth/v1', supabaseUrl).href.replace(/\/$/, ''),
        audience: 'authenticated',
        clockTolerance: CLOCK_TOLERANCE_SEC,
        currentDate,
        requiredClaims: ['sub', 'exp', 'iat', 'session_id'],
      });
      rawPayload = verified.payload;
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ERR_JWT_EXPIRED') {
        options.logger.warn('Access token was rejected', { reason: 'expired' });
        return { ok: false, error: { code: 'auth.token_expired' } };
      }
      if (
        error instanceof JwksFetchUnavailableError ||
        (code && UNAVAILABLE_JWKS_CODES.has(code))
      ) {
        return unavailable(options.logger, 'jwks');
      }
      return invalidToken(options.logger, 'signature');
    }

    const parsed = authClaimsSchema.safeParse(rawPayload);
    if (!parsed.success) return invalidToken(options.logger, 'claims');
    if (parsed.data.iat > currentDate.getTime() / 1_000 + CLOCK_TOLERANCE_SEC) {
      return invalidToken(options.logger, 'claims');
    }

    const appMetadata = parsed.data.app_metadata;
    if (appMetadata !== undefined && !isRecord(appMetadata)) {
      options.logger.warn('Auth metadata was discarded', {
        claim: 'app_metadata',
        reason: 'invalid_object',
      });
    }
    const appRoles = readRoleList(readMetadataClaim(appMetadata, 'roles'), 'roles', options.logger);
    const providers = readRoleList(
      readMetadataClaim(appMetadata, 'providers'),
      'providers',
      options.logger,
    );
    const dbClaims = parseUserDbClaims({
      sub: parsed.data.sub,
      role: parsed.data.role,
      aal: parsed.data.aal,
      session_id: parsed.data.session_id,
    });
    const context = {
      kind: 'user' as const,
      userId: parsed.data.sub,
      sessionId: parsed.data.session_id,
      aal: parsed.data.aal,
      email: parsed.data.email ?? null,
      isAnonymous: parsed.data.is_anonymous ?? false,
      appRoles,
      providers,
      amr: parsed.data.amr,
      dbClaims,
    };

    try {
      if (await options.deletedAccountMarkerReader.isDeleted(context.userId)) {
        options.logger.warn('Access token belongs to a deleted account', {
          reason: 'account_deleted',
        });
        return { ok: false, error: { code: 'auth.account_deleted' } };
      }
    } catch {
      return unavailable(options.logger, 'deleted_marker');
    }

    const localeHint = readMetadataClaim(parsed.data.user_metadata, 'locale');
    if (typeof localeHint === 'string' && allowedLocales.has(localeHint)) {
      storeProfileLocaleHint(context, localeHint);
    }

    return { ok: true, value: context };
  }

  return Object.freeze({ verifyAccessToken });
}
