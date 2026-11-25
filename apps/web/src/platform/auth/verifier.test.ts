import { exportJWK, generateKeyPair, generateSecret, SignJWT, type JWK } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';

import { createDefineRoute } from '../http/define-route';
import type { AppLogger } from '../observability/logger';
import { createTestRouteDependencies } from '../testing/route-dependencies';
import { getProfileLocaleHint } from './index';
import { createAuthVerifier } from './verifier';

const SUPABASE_URL = 'https://project.supabase.co';
const ISSUER = `${SUPABASE_URL}/auth/v1`;
const USER_ID = 'c4a76084-7818-42af-a4bb-4146655a8d31';
const SESSION_ID = 'b80d4969-7b29-4f96-9cdb-145f927de0d3';
const INITIAL_TIME_MS = Date.UTC(2026, 10, 25, 12, 0, 0);
const INITIAL_TIME_SEC = INITIAL_TIME_MS / 1_000;

type EphemeralKeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

type CapturedLog = {
  readonly level: 'warn' | 'error';
  readonly message: string;
  readonly fields: Readonly<Record<string, unknown>>;
};

function captureLogger(): { readonly logger: AppLogger; readonly logs: CapturedLog[] } {
  const logs: CapturedLog[] = [];
  return {
    logs,
    logger: {
      info() {},
      warn(message, fields) {
        logs.push({ level: 'warn', message, fields });
      },
      error(message, fields) {
        logs.push({ level: 'error', message, fields });
      },
    },
  };
}

function responseWithJwks(keys: readonly JWK[]): Response {
  return new Response(JSON.stringify({ keys }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createHarness(
  input: {
    readonly jwks?: () => readonly JWK[];
    readonly fetch?: typeof fetch;
    readonly isDeleted?: (userId: string) => Promise<boolean>;
    readonly now?: () => Date;
  } = {},
) {
  const captured = captureLogger();
  let fetchCount = 0;
  const fetchUrls: string[] = [];
  const fetchJwks = input.fetch ?? (async () => responseWithJwks(input.jwks?.() ?? []));
  const markerLookups: string[] = [];
  const verifier = createAuthVerifier({
    supabaseUrl: SUPABASE_URL,
    logger: captured.logger,
    now: input.now ?? (() => new Date(INITIAL_TIME_MS)),
    fetch: async (url, options) => {
      fetchCount += 1;
      fetchUrls.push(url);
      return fetchJwks(url, options);
    },
    deletedAccountMarkerReader: {
      async isDeleted(userId) {
        markerLookups.push(userId);
        return input.isDeleted ? input.isDeleted(userId) : false;
      },
    },
    allowedLocales: ['en', 'pt-BR', 'es'],
  });
  return {
    verifier,
    logs: captured.logs,
    markerLookups,
    fetchCount: () => fetchCount,
    fetchUrls,
  };
}

function publicJwk(
  keyPair: EphemeralKeyPair,
  kid: string,
  alg: 'ES256' | 'RS256' = 'ES256',
): Promise<JWK> {
  return exportJWK(keyPair.publicKey).then((jwk) => ({
    ...jwk,
    kid,
    alg,
    use: 'sig',
  }));
}

async function signAccessToken(input: {
  readonly keyPair: EphemeralKeyPair;
  readonly kid?: string;
  readonly alg?: 'ES256' | 'RS256';
  readonly jku?: string;
  readonly x5u?: string;
  readonly claims?: Record<string, unknown>;
  readonly sub?: string;
  readonly issuer?: string;
  readonly audience?: string;
  readonly issuedAt?: number;
  readonly expiresAt?: number;
}): Promise<string> {
  const issuedAt = input.issuedAt ?? INITIAL_TIME_SEC;
  const expiresAt = input.expiresAt ?? INITIAL_TIME_SEC + 900;
  return new SignJWT({
    session_id: SESSION_ID,
    role: 'authenticated',
    aal: 'aal1',
    amr: [{ method: 'password', timestamp: INITIAL_TIME_SEC }],
    app_metadata: { roles: ['pro'], providers: ['email'] },
    user_metadata: { locale: 'en', display_name: 'must not escape' },
    ...input.claims,
  })
    .setProtectedHeader({
      alg: input.alg ?? 'ES256',
      kid: input.kid ?? 'key-1',
      ...(input.jku ? { jku: input.jku } : {}),
      ...(input.x5u ? { x5u: input.x5u } : {}),
    })
    .setIssuer(input.issuer ?? ISSUER)
    .setAudience(input.audience ?? 'authenticated')
    .setSubject(input.sub ?? USER_ID)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(input.keyPair.privateKey);
}

describe('Supabase access token verification', () => {
  let primaryKeyPair: EphemeralKeyPair;
  let alternateKeyPair: EphemeralKeyPair;
  let primaryJwk: JWK;

  beforeAll(async () => {
    primaryKeyPair = await generateKeyPair('ES256');
    alternateKeyPair = await generateKeyPair('ES256');
    primaryJwk = await publicJwk(primaryKeyPair, 'key-1');
  });

  it('returns a minimal typed context and keeps only an allowed locale in the private accessor', async () => {
    const harness = createHarness({ jwks: () => [primaryJwk] });
    const token = await signAccessToken({ keyPair: primaryKeyPair });

    const result = await harness.verifier.verifyAccessToken(token);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      kind: 'user',
      userId: USER_ID,
      sessionId: SESSION_ID,
      aal: 'aal1',
      email: null,
      isAnonymous: false,
      appRoles: ['pro'],
      providers: ['email'],
      amr: [{ method: 'password', timestamp: INITIAL_TIME_SEC }],
      dbClaims: {
        sub: USER_ID,
        role: 'authenticated',
        aal: 'aal1',
        session_id: SESSION_ID,
      },
    });
    expect(Object.keys(result.value.dbClaims).sort()).toEqual(['aal', 'role', 'session_id', 'sub']);
    expect(getProfileLocaleHint(result.value)).toBe('en');
    expect(harness.markerLookups).toEqual([USER_ID]);
    expect(harness.fetchCount()).toBe(1);
  });

  it('caches keys after a successful fetch', async () => {
    const harness = createHarness({ jwks: () => [primaryJwk] });
    const token = await signAccessToken({ keyPair: primaryKeyPair });

    expect((await harness.verifier.verifyAccessToken(token)).ok).toBe(true);
    expect((await harness.verifier.verifyAccessToken(token)).ok).toBe(true);
    expect(harness.fetchCount()).toBe(1);
  });

  it('uses the configured JWKS URL even when token headers carry jku or x5u values', async () => {
    const harness = createHarness({ jwks: () => [primaryJwk] });
    const token = await signAccessToken({
      keyPair: primaryKeyPair,
      jku: 'https://attacker.example/jwks.json',
      x5u: 'https://attacker.example/certificate.pem',
    });

    expect((await harness.verifier.verifyAccessToken(token)).ok).toBe(true);
    expect(harness.fetchUrls).toEqual([
      'https://project.supabase.co/auth/v1/.well-known/jwks.json',
    ]);
  });

  it('passes the verified subject through the protected HTTP pipeline and maps verifier failures', async () => {
    const harness = createHarness({ jwks: () => [primaryJwk] });
    const verifyAccessToken = (token: string) => harness.verifier.verifyAccessToken(token);
    const test = createTestRouteDependencies({
      overrides: { authenticateUser: verifyAccessToken },
    });
    const route = createDefineRoute(test.dependencies)({
      operationId: 'verifiedSubjectTest',
      auth: { kind: 'user' },
      rateLimit: { key: 'user', limit: 30, windowSec: 60, onStoreFailure: 'closed' },
      output: z.strictObject({ subject: z.uuid() }),
      handler: ({ auth }) => {
        if (auth?.kind !== 'user') throw new Error('A user context is required.');
        return { subject: auth.userId };
      },
    });
    const token = await signAccessToken({ keyPair: primaryKeyPair });
    const requestFor = (accessToken: string) =>
      new Request('https://app.example/api/v1/test', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'x-real-ip': '198.51.100.12',
        },
      });

    const success = await route(requestFor(token));
    expect(success.status).toBe(200);
    expect(await success.json()).toEqual({ subject: USER_ID });

    const rejected = await route(requestFor('malformed-token'));
    expect(rejected.status).toBe(401);
    expect(await rejected.json()).toMatchObject({ code: 'auth.invalid_token' });
  });

  it('accepts RS256 public-key signatures as well as ES256', async () => {
    const rsaKeyPair = await generateKeyPair('RS256');
    const rsaJwk = await publicJwk(rsaKeyPair, 'rsa-key', 'RS256');
    const harness = createHarness({ jwks: () => [rsaJwk] });
    const token = await signAccessToken({ keyPair: rsaKeyPair, kid: 'rsa-key', alg: 'RS256' });

    expect((await harness.verifier.verifyAccessToken(token)).ok).toBe(true);
    expect(harness.fetchCount()).toBe(1);
  });

  it('refreshes a rotated key after cooldown and rejects a kid absent from a refreshed JWKS', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(INITIAL_TIME_MS));
    try {
      const rotatedKeyPair = await generateKeyPair('ES256');
      const rotatedJwk = await publicJwk(rotatedKeyPair, 'key-2');
      let currentKeys: readonly JWK[] = [primaryJwk];
      const harness = createHarness({
        jwks: () => currentKeys,
        now: () => new Date(Date.now()),
      });
      const firstToken = await signAccessToken({ keyPair: primaryKeyPair, kid: 'key-1' });
      const rotatedToken = await signAccessToken({ keyPair: rotatedKeyPair, kid: 'key-2' });

      expect((await harness.verifier.verifyAccessToken(firstToken)).ok).toBe(true);
      currentKeys = [rotatedJwk];
      const duringCooldown = await harness.verifier.verifyAccessToken(rotatedToken);
      expect(duringCooldown).toEqual({ ok: false, error: { code: 'auth.invalid_token' } });
      expect(harness.fetchCount()).toBe(1);

      vi.setSystemTime(new Date(INITIAL_TIME_MS + 60_001));
      expect((await harness.verifier.verifyAccessToken(rotatedToken)).ok).toBe(true);
      expect(harness.fetchCount()).toBe(2);

      const unknownKeyPair = await generateKeyPair('ES256');
      const unknownToken = await signAccessToken({ keyPair: unknownKeyPair, kid: 'missing-key' });
      vi.setSystemTime(new Date(INITIAL_TIME_MS + 120_002));
      expect(await harness.verifier.verifyAccessToken(unknownToken)).toEqual({
        ok: false,
        error: { code: 'auth.invalid_token' },
      });
      expect(harness.fetchCount()).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects oversized, non-allowlisted, malformed, and incorrectly signed tokens', async () => {
    const harness = createHarness({ jwks: () => [primaryJwk] });
    const oversized = await harness.verifier.verifyAccessToken('x'.repeat(4_097));
    expect(oversized).toEqual({ ok: false, error: { code: 'auth.invalid_token' } });
    expect(harness.fetchCount()).toBe(0);

    const unsecured = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from('{}').toString('base64url')}.`;
    expect(await harness.verifier.verifyAccessToken(unsecured)).toEqual({
      ok: false,
      error: { code: 'auth.invalid_token' },
    });

    const malformed = await harness.verifier.verifyAccessToken('not-a-jwt');
    expect(malformed).toEqual({ ok: false, error: { code: 'auth.invalid_token' } });

    const badSignature = await signAccessToken({
      keyPair: alternateKeyPair,
      kid: 'key-1',
    });
    expect(await harness.verifier.verifyAccessToken(badSignature)).toEqual({
      ok: false,
      error: { code: 'auth.invalid_token' },
    });
  });

  it('rejects issuer and audience mismatches and validates the application claims', async () => {
    const harness = createHarness({ jwks: () => [primaryJwk] });
    const wrongIssuer = await signAccessToken({
      keyPair: primaryKeyPair,
      issuer: 'https://other.test',
    });
    const wrongAudience = await signAccessToken({
      keyPair: primaryKeyPair,
      audience: 'other',
    });
    const invalidRole = await signAccessToken({
      keyPair: primaryKeyPair,
      claims: { role: 'anon' },
    });
    const invalidSession = await signAccessToken({
      keyPair: primaryKeyPair,
      claims: { session_id: 'not-a-uuid' },
    });

    for (const token of [wrongIssuer, wrongAudience, invalidRole, invalidSession]) {
      expect(await harness.verifier.verifyAccessToken(token)).toEqual({
        ok: false,
        error: { code: 'auth.invalid_token' },
      });
    }
  });

  it('uses the 30 second expiration tolerance and rejects tokens expired beyond it', async () => {
    const harness = createHarness({ jwks: () => [primaryJwk] });
    const withinGrace = await signAccessToken({
      keyPair: primaryKeyPair,
      issuedAt: INITIAL_TIME_SEC - 60,
      expiresAt: INITIAL_TIME_SEC - 29,
    });
    const beyondGrace = await signAccessToken({
      keyPair: primaryKeyPair,
      issuedAt: INITIAL_TIME_SEC - 60,
      expiresAt: INITIAL_TIME_SEC - 31,
    });

    expect((await harness.verifier.verifyAccessToken(withinGrace)).ok).toBe(true);
    expect(await harness.verifier.verifyAccessToken(beyondGrace)).toEqual({
      ok: false,
      error: { code: 'auth.token_expired' },
    });
  });

  it('rejects future iat beyond tolerance and treats an invalid optional metadata list as empty', async () => {
    const harness = createHarness({ jwks: () => [primaryJwk] });
    const futureIssuedAt = await signAccessToken({
      keyPair: primaryKeyPair,
      issuedAt: INITIAL_TIME_SEC + 31,
    });
    const invalidMetadata = await signAccessToken({
      keyPair: primaryKeyPair,
      claims: {
        app_metadata: {
          roles: ['pro', 'Not_Allowed'],
          providers: ['email'],
          ignored: 'must not escape',
        },
        user_metadata: { locale: 'pt' },
      },
    });

    expect(await harness.verifier.verifyAccessToken(futureIssuedAt)).toEqual({
      ok: false,
      error: { code: 'auth.invalid_token' },
    });
    const result = await harness.verifier.verifyAccessToken(invalidMetadata);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.appRoles).toEqual([]);
    expect(result.value.providers).toEqual(['email']);
    expect(getProfileLocaleHint(result.value)).toBeUndefined();
    expect(harness.logs).toContainEqual({
      level: 'warn',
      message: 'Auth metadata list was discarded',
      fields: { claim: 'roles', reason: 'invalid_list' },
    });
  });

  it('rejects deleted accounts and fails closed when the marker store is unavailable', async () => {
    const token = await signAccessToken({ keyPair: primaryKeyPair });
    const deletedHarness = createHarness({
      jwks: () => [primaryJwk],
      isDeleted: async () => true,
    });
    expect(await deletedHarness.verifier.verifyAccessToken(token)).toEqual({
      ok: false,
      error: { code: 'auth.account_deleted' },
    });

    const unavailableHarness = createHarness({
      jwks: () => [primaryJwk],
      isDeleted: async () => {
        throw new Error('sensitive backend response');
      },
    });
    expect(await unavailableHarness.verifier.verifyAccessToken(token)).toEqual({
      ok: false,
      error: { code: 'auth.unavailable', retryAfterSec: 3 },
    });
    expect(JSON.stringify(unavailableHarness.logs)).not.toContain('sensitive backend response');
  });

  it('fails closed when the JWKS provider is unavailable without exposing provider errors', async () => {
    const harness = createHarness({
      fetch: async () => {
        throw new Error('private provider response');
      },
    });
    const token = await signAccessToken({ keyPair: primaryKeyPair });

    expect(await harness.verifier.verifyAccessToken(token)).toEqual({
      ok: false,
      error: { code: 'auth.unavailable', retryAfterSec: 3 },
    });
    expect(JSON.stringify(harness.logs)).not.toContain('private provider response');

    const badStatusHarness = createHarness({
      fetch: async () => new Response('private provider response', { status: 503 }),
    });
    expect(await badStatusHarness.verifier.verifyAccessToken(token)).toEqual({
      ok: false,
      error: { code: 'auth.unavailable', retryAfterSec: 3 },
    });
    expect(JSON.stringify(badStatusHarness.logs)).not.toContain('private provider response');
  });

  it('returns unavailable when the Supabase URL is not configured', async () => {
    const captured = captureLogger();
    const verifier = createAuthVerifier({
      supabaseUrl: undefined,
      logger: captured.logger,
      deletedAccountMarkerReader: {
        async isDeleted() {
          return false;
        },
      },
    });
    const token = await signAccessToken({ keyPair: primaryKeyPair });

    expect(await verifier.verifyAccessToken(token)).toEqual({
      ok: false,
      error: { code: 'auth.unavailable', retryAfterSec: 3 },
    });
  });
});

describe('HS256 rejection', () => {
  it('rejects shared-secret tokens before attempting a JWKS lookup', async () => {
    const sharedSecret = await generateSecret('HS256');
    const captured = captureLogger();
    let fetchCount = 0;
    const verifier = createAuthVerifier({
      supabaseUrl: SUPABASE_URL,
      logger: captured.logger,
      deletedAccountMarkerReader: {
        async isDeleted() {
          return false;
        },
      },
      fetch: async () => {
        fetchCount += 1;
        return responseWithJwks([]);
      },
    });
    const token = await new SignJWT({
      session_id: SESSION_ID,
      role: 'authenticated',
      aal: 'aal1',
      amr: [],
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setSubject(USER_ID)
      .setIssuedAt(INITIAL_TIME_SEC)
      .setExpirationTime(INITIAL_TIME_SEC + 900)
      .sign(sharedSecret);

    expect(await verifier.verifyAccessToken(token)).toEqual({
      ok: false,
      error: { code: 'auth.invalid_token' },
    });
    expect(fetchCount).toBe(0);
  });
});
