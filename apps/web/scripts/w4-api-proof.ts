import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { createLegalVersionsReader } from '../src/modules/app-config';
import { createCoreComposition } from '../src/platform/composition/core';
import { createDatabase } from '../src/platform/db';
import type { DatabaseEnvironment } from '../src/platform/env';
import type { AppLogger } from '../src/platform/observability/logger';
import { createAuthVerifier } from '../src/platform/auth/verifier';
import type { AuthVerificationResult } from '../src/platform/auth/types';
import { createDefineRoute } from '../src/platform/http/define-route';
import { createCoreRouteDefinitions } from '../src/platform/http/core-routes';
import { createUuidV7 } from '../src/platform/http/request-id';
import type {
  IdempotencyAcquireResult,
  IdempotencyStore,
  RouteDependencies,
} from '../src/platform/http/types';
import type { RateLimiter, RateLimitResult } from '../src/platform/http/rate-limit';

const EXPECTED_API_ORIGIN = 'http://127.0.0.1:54421';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_CODE_PATTERN = /^[a-z][a-z0-9_.-]{0,95}$/;
const EMAIL_PATTERN = /^[^\s@]+@example\.invalid$/i;
const ROLE_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const REPORT_MARKER = 'W4_API_PROOF_RESULT=';

type FixtureCredentials = {
  readonly email: string;
  readonly password: string;
  readonly userId: string;
};

type ProofInput = {
  readonly apiOrigin: string;
  readonly anonymousKey: string;
  readonly adminKey: string;
  readonly fixtureA: FixtureCredentials;
  readonly database: DatabaseEnvironment;
};

type SafeCheck = {
  readonly name: string;
  readonly passed: boolean;
  readonly status?: number;
  readonly code?: string;
  readonly count?: number;
};

type SafeProofResult = {
  readonly passed: boolean;
  readonly checks: readonly SafeCheck[];
  readonly failedCheck?: string;
};

type SafeResponse = {
  readonly status: number;
  readonly code?: string;
  readonly retryAfter?: string;
  readonly body: unknown;
};

type LoginResult = {
  readonly token: string;
};

type CreatedFixture = {
  readonly credentials: FixtureCredentials;
  readonly userMetadataLocale: string;
};

type DatabaseWithCounter = ReturnType<typeof createDatabase> & {
  readonly getUserScopedCallCount: () => number;
};

class ProofFailure extends Error {
  constructor(readonly checkName: string) {
    super('W4 integration proof failed.');
    this.name = 'ProofFailure';
  }
}

const logger: AppLogger = Object.freeze({
  info() {},
  warn() {},
  error() {},
});

const alwaysAllowRateLimiter: RateLimiter = Object.freeze({
  async consume(input): Promise<RateLimitResult> {
    return {
      allowed: true,
      limit: input.limit,
      remaining: input.limit - 1,
      resetAtMs: input.nowMs + input.windowSec * 1_000,
    };
  },
});

const unavailableIdempotencyStore: IdempotencyStore = Object.freeze({
  async acquire(): Promise<IdempotencyAcquireResult> {
    throw new Error('Unexpected idempotency request in W4 proof.');
  },
  async complete(): Promise<void> {
    throw new Error('Unexpected idempotency completion in W4 proof.');
  },
  async release(): Promise<void> {
    throw new Error('Unexpected idempotency release in W4 proof.');
  },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeCode(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_CODE_PATTERN.test(value) ? value : undefined;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`input.${field}`);
  return value;
}

function parseFixture(value: unknown, name: string): FixtureCredentials {
  if (!isRecord(value)) throw new Error(`input.${name}`);
  const email = requireString(value.email, `${name}.email`);
  const password = requireString(value.password, `${name}.password`);
  const userId = requireString(value.userId, `${name}.userId`);
  if (!EMAIL_PATTERN.test(email) || !UUID_PATTERN.test(userId) || password.length < 12) {
    throw new Error(`input.${name}`);
  }
  return { email, password, userId };
}

function parseInput(value: unknown): ProofInput {
  if (!isRecord(value) || !isRecord(value.database)) throw new Error('input.shape');
  const apiOrigin = requireString(value.apiOrigin, 'apiOrigin');
  const parsedApiOrigin = new URL(apiOrigin);
  if (
    parsedApiOrigin.origin !== EXPECTED_API_ORIGIN ||
    parsedApiOrigin.pathname !== '/' ||
    parsedApiOrigin.search !== '' ||
    parsedApiOrigin.hash !== ''
  ) {
    throw new Error('input.api_origin');
  }

  const database = {
    DATABASE_URL: requireString(value.database.DATABASE_URL, 'database.DATABASE_URL'),
    DATABASE_CA_CERT: requireString(value.database.DATABASE_CA_CERT, 'database.DATABASE_CA_CERT'),
  };
  const databaseUrl = new URL(database.DATABASE_URL);
  if (
    !['postgres:', 'postgresql:'].includes(databaseUrl.protocol) ||
    decodeURIComponent(databaseUrl.username) !== 'api_runtime'
  ) {
    throw new Error('input.database_role');
  }

  return {
    apiOrigin,
    anonymousKey: requireString(value.anonymousKey, 'anonymousKey'),
    adminKey: requireString(value.adminKey, 'adminKey'),
    fixtureA: parseFixture(value.fixtureA, 'fixtureA'),
    database,
  };
}

function assertCheck(
  checks: SafeCheck[],
  name: string,
  passed: boolean,
  fields: Omit<SafeCheck, 'name' | 'passed'> = {},
): void {
  checks.push({ name, passed, ...fields });
  if (!passed) throw new ProofFailure(name);
}

function addCleanupCheck(checks: SafeCheck[], name: string, passed: boolean): void {
  checks.push({ name, passed });
}

async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function safeResponse(response: Response): Promise<SafeResponse> {
  const body = response.status === 204 ? null : await readJsonResponse(response);
  const code = isRecord(body) ? safeCode(body.code) : undefined;
  const retryAfter = response.headers.get('retry-after') ?? undefined;
  return {
    status: response.status,
    ...(code === undefined ? {} : { code }),
    ...(retryAfter === undefined ? {} : { retryAfter }),
    body,
  };
}

async function requestJson(
  url: string,
  init: RequestInit,
): Promise<{ readonly response: Response; readonly body: unknown }> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(10_000),
    cache: 'no-store',
    redirect: 'error',
  });
  return { response, body: await readJsonResponse(response) };
}

async function createFixture(input: ProofInput, locale: string): Promise<CreatedFixture> {
  const email = `${randomBytes(18).toString('hex')}@example.invalid`;
  const password = randomBytes(32).toString('hex');
  const { response, body } = await requestJson(`${input.apiOrigin}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: input.adminKey,
      authorization: `Bearer ${input.adminKey}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      app_metadata: { roles: ['member'] },
      user_metadata: { locale },
    }),
  });
  if (!response.ok || !isRecord(body) || typeof body.id !== 'string') {
    throw new ProofFailure('fixture.create');
  }
  const userId = body.id;
  if (!UUID_PATTERN.test(userId)) throw new ProofFailure('fixture.create');
  return { credentials: { email, password, userId }, userMetadataLocale: locale };
}

async function adminRequest(
  input: ProofInput,
  method: 'GET' | 'PUT' | 'DELETE',
  userId: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const { response, body: result } = await requestJson(
    `${input.apiOrigin}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
    {
      method,
      headers: {
        apikey: input.adminKey,
        authorization: `Bearer ${input.adminKey}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  if (!response.ok) throw new ProofFailure('admin.operation');
  return result;
}

async function login(input: ProofInput, fixture: FixtureCredentials): Promise<LoginResult> {
  const { response, body } = await requestJson(
    `${input.apiOrigin}/auth/v1/token?grant_type=password`,
    {
      method: 'POST',
      headers: {
        apikey: input.anonymousKey,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email: fixture.email, password: fixture.password }),
    },
  );
  if (
    !response.ok ||
    !isRecord(body) ||
    typeof body.access_token !== 'string' ||
    typeof body.user !== 'object' ||
    body.user === null ||
    !isRecord(body.user) ||
    typeof body.user.id !== 'string' ||
    body.user.id !== fixture.userId
  ) {
    throw new ProofFailure('auth.password_login');
  }
  return { token: body.access_token };
}

function isProfile(value: unknown): value is {
  readonly id: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly locale: string;
  readonly createdAt: string;
  readonly consents: { readonly needsAcceptance: readonly string[] };
} {
  if (!isRecord(value) || !isRecord(value.consents)) return false;
  return (
    typeof value.id === 'string' &&
    (typeof value.email === 'string' || value.email === null) &&
    (typeof value.displayName === 'string' || value.displayName === null) &&
    typeof value.locale === 'string' &&
    typeof value.createdAt === 'string' &&
    Array.isArray(value.consents.needsAcceptance)
  );
}

function previousDateVersion(version: string): string {
  const time = Date.parse(`${version}T00:00:00.000Z`);
  if (!Number.isFinite(time)) throw new ProofFailure('consent.version_shape');
  return new Date(time - 86_400_000).toISOString().slice(0, 10);
}

function decodeJsonSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown;
}

function makeUnsignedToken(token: string): string {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] === undefined || parts[1] === undefined) {
    throw new ProofFailure('auth.jwt_shape');
  }
  const payload = decodeJsonSegment(parts[1]);
  if (!isRecord(payload)) throw new ProofFailure('auth.jwt_shape');
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  return `${header}.${parts[1]}.`;
}

function corruptSignature(token: string): string {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[2] === undefined || parts[2].length < 2) {
    throw new ProofFailure('auth.jwt_shape');
  }
  const first = parts[2][0] === 'A' ? 'B' : 'A';
  return `${parts[0]}.${parts[1]}.${first}${parts[2].slice(1)}`;
}

function expirationFromToken(token: string): number {
  const payloadPart = token.split('.')[1];
  if (!payloadPart) throw new ProofFailure('auth.jwt_shape');
  const payload = decodeJsonSegment(payloadPart);
  if (!isRecord(payload) || typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
    throw new ProofFailure('auth.jwt_expiration');
  }
  return payload.exp;
}

function createCountedDatabase(input: ProofInput): DatabaseWithCounter {
  const database = createDatabase(input.database, { extensionSystemRoles: [], logger });
  let userScopedCallCount = 0;
  return Object.freeze({
    async userScopedDb(...args: Parameters<typeof database.userScopedDb>) {
      userScopedCallCount += 1;
      return database.userScopedDb(...args);
    },
    systemDb: database.systemDb.bind(database),
    destroy: database.destroy.bind(database),
    getUserScopedCallCount: () => userScopedCallCount,
  }) as DatabaseWithCounter;
}

function createRouteHandlers(
  input: ProofInput,
  authVerifier: ReturnType<typeof createAuthVerifier>,
  composition: ReturnType<typeof createCoreComposition>,
  now: () => Date,
) {
  const routeDependencies: RouteDependencies = {
    now,
    requestId: () => createUuidV7(now().getTime()),
    recentAuthMaxAgeSec: 300,
    logger,
    rateLimiter: alwaysAllowRateLimiter,
    idempotencyStore: unavailableIdempotencyStore,
    authenticateUser: async (token): Promise<AuthVerificationResult> =>
      authVerifier.verifyAccessToken(token),
    checkVersionAndMaintenance: async () => ({ allow: true }),
    authorizationPolicies: new Map(),
    loadFreshRoles: (auth) => composition.loadFreshRoles(auth),
    recordSecurityEvent: async () => undefined,
  };
  const defineRoute = createDefineRoute(routeDependencies);
  const definitions = createCoreRouteDefinitions(() => composition);
  return {
    getMe: defineRoute(definitions.getMe),
    updateMe: defineRoute(definitions.updateMe),
    acceptConsent: defineRoute(definitions.acceptConsent),
    apiOrigin: input.apiOrigin,
  };
}

function authenticatedRequest(
  apiOrigin: string,
  path: string,
  method: 'GET' | 'PATCH' | 'POST',
  token: string,
  body?: unknown,
): Request {
  return new Request(`${apiOrigin}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function meResponse(response: Response): Promise<{
  readonly response: SafeResponse;
  readonly me?: ReturnType<typeof readProfileBody>;
}> {
  const body = response.status === 204 ? null : await readJsonResponse(response);
  const problemCode = isRecord(body) ? safeCode(body.code) : undefined;
  const safe: SafeResponse = {
    status: response.status,
    ...(problemCode === undefined ? {} : { code: problemCode }),
    ...(response.headers.get('retry-after') === null
      ? {}
      : { retryAfter: response.headers.get('retry-after') ?? undefined }),
    body,
  };
  return { response: safe, ...(isProfile(body) ? { me: readProfileBody(body) } : {}) };
}

function readProfileBody(value: unknown): {
  readonly id: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly locale: string;
  readonly createdAt: string;
  readonly consents: { readonly needsAcceptance: readonly string[] };
} {
  if (!isProfile(value)) throw new ProofFailure('profile.response');
  return value;
}

async function getProfile(
  route: (request: Request) => Promise<Response>,
  input: {
    readonly apiOrigin: string;
    readonly token: string;
  },
): Promise<{ readonly response: SafeResponse; readonly me?: ReturnType<typeof readProfileBody> }> {
  return meResponse(
    await route(authenticatedRequest(input.apiOrigin, '/v1/me', 'GET', input.token)),
  );
}

async function countProfiles(
  database: ReturnType<typeof createDatabase>,
  userId: string,
): Promise<number> {
  return database.systemDb('identity', async (transaction) => {
    const row = await transaction
      .selectFrom('identity.profiles')
      .select(({ fn }) => fn.countAll().as('count'))
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  });
}

async function readAcceptedAt(
  database: ReturnType<typeof createDatabase>,
  userId: string,
  document: 'terms' | 'privacy',
  version: string,
): Promise<string | undefined> {
  return database.systemDb('privacy', async (transaction) => {
    const row = await transaction
      .selectFrom('privacy.consents')
      .select('accepted_at')
      .where('user_id', '=', userId)
      .where('document', '=', document)
      .where('version', '=', version)
      .executeTakeFirst();
    return row?.accepted_at;
  });
}

async function countConsents(
  database: ReturnType<typeof createDatabase>,
  userId: string,
  document: 'terms' | 'privacy',
  version: string,
): Promise<number> {
  return database.systemDb('privacy', async (transaction) => {
    const row = await transaction
      .selectFrom('privacy.consents')
      .select(({ fn }) => fn.countAll().as('count'))
      .where('user_id', '=', userId)
      .where('document', '=', document)
      .where('version', '=', version)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  });
}

function adminAppMetadata(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value.app_metadata)) {
    throw new ProofFailure('roles.metadata_shape');
  }
  return structuredClone(value.app_metadata);
}

async function runProof(input: ProofInput): Promise<SafeProofResult> {
  const checks: SafeCheck[] = [];
  const createdUsers: string[] = [];
  let phase = 'fixture.create';
  let failedCheck: string | undefined;
  let metadataSnapshot: Record<string, unknown> | undefined;
  let metadataUpdateAttempted = false;
  let metadataRestored = true;
  let database: DatabaseWithCounter | undefined;

  const verifierClock = { value: new Date() };
  const deletedUsers = new Set<string>();
  let markerFailure = false;
  const authVerifier = createAuthVerifier({
    supabaseUrl: input.apiOrigin,
    deletedAccountMarkerReader: {
      async isDeleted(userId) {
        if (markerFailure) throw new Error('Marker store unavailable.');
        return deletedUsers.has(userId);
      },
    },
    logger,
    now: () => new Date(verifierClock.value.getTime()),
  });

  try {
    const fixtureB = await createFixture(input, 'es');
    createdUsers.push(fixtureB.credentials.userId);
    const fixtureC = await createFixture(input, 'en');
    createdUsers.push(fixtureC.credentials.userId);
    assertCheck(checks, 'fixtures.created', true, { count: createdUsers.length });

    phase = 'database.connect';
    database = createCountedDatabase(input);
    const composition = createCoreComposition({ database, logger });
    const routes = createRouteHandlers(input, authVerifier, composition, () => new Date());
    const [{ token: tokenA }, { token: tokenB }, { token: tokenC }] = await Promise.all([
      login(input, input.fixtureA),
      login(input, fixtureB.credentials),
      login(input, fixtureC.credentials),
    ]);
    assertCheck(checks, 'auth.real_logins', true, { count: 3 });

    phase = 'auth.valid_pipeline';
    const validA = await getProfile(routes.getMe, { apiOrigin: input.apiOrigin, token: tokenA });
    assertCheck(
      checks,
      'auth.valid_token_200',
      validA.response.status === 200 && validA.me?.id === input.fixtureA.userId,
      {
        status: validA.response.status,
        ...(validA.response.code ? { code: validA.response.code } : {}),
      },
    );

    phase = 'profile.concurrent_create';
    const parallelProfiles = await Promise.all([
      getProfile(routes.getMe, { apiOrigin: input.apiOrigin, token: tokenB }),
      getProfile(routes.getMe, { apiOrigin: input.apiOrigin, token: tokenB }),
      getProfile(routes.getMe, { apiOrigin: input.apiOrigin, token: tokenB }),
    ]);
    const profilesAreConsistent = parallelProfiles.every(
      (result) =>
        result.response.status === 200 &&
        result.me?.id === fixtureB.credentials.userId &&
        result.me.locale === fixtureB.userMetadataLocale,
    );
    const profileCount = await countProfiles(database, fixtureB.credentials.userId);
    assertCheck(
      checks,
      'profile.concurrent_single_create',
      profilesAreConsistent && profileCount === 1,
      {
        count: profileCount,
      },
    );

    phase = 'profile.created_at';
    const profileRead = await getProfile(routes.getMe, {
      apiOrigin: input.apiOrigin,
      token: tokenB,
    });
    const profileRows = await database.systemDb('identity', (transaction) =>
      transaction
        .selectFrom('identity.profiles')
        .select('created_at')
        .where('user_id', '=', fixtureB.credentials.userId)
        .executeTakeFirstOrThrow(),
    );
    assertCheck(
      checks,
      'profile.created_at_is_profile_row',
      profileRead.response.status === 200 &&
        profileRead.me?.createdAt === new Date(profileRows.created_at).toISOString(),
      { status: profileRead.response.status },
    );

    phase = 'profile.isolation';
    const profileC = await getProfile(routes.getMe, { apiOrigin: input.apiOrigin, token: tokenC });
    const profileA = await getProfile(routes.getMe, { apiOrigin: input.apiOrigin, token: tokenA });
    assertCheck(
      checks,
      'profile.each_jwt_uses_own_subject',
      profileC.response.status === 200 &&
        profileC.me?.id === fixtureC.credentials.userId &&
        profileA.response.status === 200 &&
        profileA.me?.id === input.fixtureA.userId,
      { count: 3 },
    );

    phase = 'profile.patch';
    const patchResponse = await meResponse(
      await routes.updateMe(
        authenticatedRequest(input.apiOrigin, '/v1/me', 'PATCH', tokenB, {
          displayName: '  Ana  ',
          locale: 'pt-BR',
        }),
      ),
    );
    assertCheck(
      checks,
      'profile.patch_normalizes_and_sets_locale',
      patchResponse.response.status === 200 &&
        patchResponse.me?.displayName === 'Ana' &&
        patchResponse.me.locale === 'pt-BR',
      { status: patchResponse.response.status },
    );

    phase = 'profile.patch_unknown_body';
    const unknownPatch = await safeResponse(
      await routes.updateMe(
        authenticatedRequest(input.apiOrigin, '/v1/me', 'PATCH', tokenB, {
          locale: 'es',
          unexpected: true,
        }),
      ),
    );
    assertCheck(
      checks,
      'profile.patch_unknown_field_400',
      unknownPatch.status === 400 && unknownPatch.code === 'request.validation_failed',
      { status: unknownPatch.status, ...(unknownPatch.code ? { code: unknownPatch.code } : {}) },
    );

    phase = 'profile.patch_locale_persisted';
    const afterPatch = await getProfile(routes.getMe, {
      apiOrigin: input.apiOrigin,
      token: tokenB,
    });
    assertCheck(
      checks,
      'profile.locale_persisted',
      afterPatch.response.status === 200 && afterPatch.me?.locale === 'pt-BR',
      { status: afterPatch.response.status },
    );

    phase = 'consent.read_legal_version';
    const versions = await createLegalVersionsReader(database).readCurrent();
    const consentVersion = versions.termsVersion;
    const staleVersion = previousDateVersion(consentVersion);

    phase = 'consent.accept';
    const currentConsentBody = { document: 'terms', version: consentVersion };
    const accepted = await safeResponse(
      await routes.acceptConsent(
        authenticatedRequest(
          input.apiOrigin,
          '/v1/me/consents',
          'POST',
          tokenB,
          currentConsentBody,
        ),
      ),
    );
    const firstAcceptedAt = await readAcceptedAt(
      database,
      fixtureB.credentials.userId,
      'terms',
      consentVersion,
    );
    const acceptedAgain = await safeResponse(
      await routes.acceptConsent(
        authenticatedRequest(
          input.apiOrigin,
          '/v1/me/consents',
          'POST',
          tokenB,
          currentConsentBody,
        ),
      ),
    );
    const secondAcceptedAt = await readAcceptedAt(
      database,
      fixtureB.credentials.userId,
      'terms',
      consentVersion,
    );
    const acceptedCount = await countConsents(
      database,
      fixtureB.credentials.userId,
      'terms',
      consentVersion,
    );
    assertCheck(
      checks,
      'consent_current_204_repeat_preserves_timestamp',
      accepted.status === 204 &&
        acceptedAgain.status === 204 &&
        accepted.body === null &&
        acceptedAgain.body === null &&
        firstAcceptedAt !== undefined &&
        firstAcceptedAt === secondAcceptedAt &&
        acceptedCount === 1,
      { status: acceptedAgain.status, count: acceptedCount },
    );

    phase = 'consent.outdated';
    const outdated = await safeResponse(
      await routes.acceptConsent(
        authenticatedRequest(input.apiOrigin, '/v1/me/consents', 'POST', tokenB, {
          document: 'terms',
          version: staleVersion,
        }),
      ),
    );
    assertCheck(
      checks,
      'consent_outdated_409',
      outdated.status === 409 && outdated.code === 'privacy.consent_version_outdated',
      { status: outdated.status, ...(outdated.code ? { code: outdated.code } : {}) },
    );

    phase = 'consent.other_user_body';
    const otherIdBody = await safeResponse(
      await routes.acceptConsent(
        authenticatedRequest(input.apiOrigin, '/v1/me/consents', 'POST', tokenB, {
          document: 'privacy',
          version: versions.privacyVersion,
          userId: fixtureC.credentials.userId,
        }),
      ),
    );
    const injectedConsentCount = await countConsents(
      database,
      fixtureB.credentials.userId,
      'privacy',
      versions.privacyVersion,
    );
    assertCheck(
      checks,
      'consent_other_user_id_body_400_without_write',
      otherIdBody.status === 400 &&
        otherIdBody.code === 'request.validation_failed' &&
        injectedConsentCount === 0,
      {
        status: otherIdBody.status,
        count: injectedConsentCount,
        ...(otherIdBody.code ? { code: otherIdBody.code } : {}),
      },
    );

    phase = 'auth.alg_none';
    const unsigned = await getProfile(routes.getMe, {
      apiOrigin: input.apiOrigin,
      token: makeUnsignedToken(tokenA),
    });
    assertCheck(
      checks,
      'auth_alg_none_401',
      unsigned.response.status === 401 && unsigned.response.code === 'auth.invalid_token',
      {
        status: unsigned.response.status,
        ...(unsigned.response.code ? { code: unsigned.response.code } : {}),
      },
    );

    phase = 'auth.signature_corrupt';
    const corrupted = await getProfile(routes.getMe, {
      apiOrigin: input.apiOrigin,
      token: corruptSignature(tokenA),
    });
    assertCheck(
      checks,
      'auth_corrupt_signature_401',
      corrupted.response.status === 401 && corrupted.response.code === 'auth.invalid_token',
      {
        status: corrupted.response.status,
        ...(corrupted.response.code ? { code: corrupted.response.code } : {}),
      },
    );

    phase = 'auth.expired_clock';
    verifierClock.value = new Date((expirationFromToken(tokenA) + 31) * 1_000);
    const expired = await getProfile(routes.getMe, {
      apiOrigin: input.apiOrigin,
      token: tokenA,
    });
    verifierClock.value = new Date();
    assertCheck(
      checks,
      'auth_expired_clock_tolerance_401',
      expired.response.status === 401 && expired.response.code === 'auth.token_expired',
      {
        status: expired.response.status,
        ...(expired.response.code ? { code: expired.response.code } : {}),
      },
    );

    phase = 'auth.deleted_marker';
    deletedUsers.add(input.fixtureA.userId);
    const deleted = await getProfile(routes.getMe, {
      apiOrigin: input.apiOrigin,
      token: tokenA,
    });
    deletedUsers.delete(input.fixtureA.userId);
    assertCheck(
      checks,
      'auth_deleted_marker_401',
      deleted.response.status === 401 && deleted.response.code === 'auth.account_deleted',
      {
        status: deleted.response.status,
        ...(deleted.response.code ? { code: deleted.response.code } : {}),
      },
    );

    phase = 'auth.marker_unavailable';
    markerFailure = true;
    const markerUnavailable = await getProfile(routes.getMe, {
      apiOrigin: input.apiOrigin,
      token: tokenA,
    });
    markerFailure = false;
    assertCheck(
      checks,
      'auth_marker_failure_closed_503',
      markerUnavailable.response.status === 503 &&
        markerUnavailable.response.code === 'auth.unavailable' &&
        markerUnavailable.response.retryAfter === '3',
      {
        status: markerUnavailable.response.status,
        ...(markerUnavailable.response.code ? { code: markerUnavailable.response.code } : {}),
      },
    );

    phase = 'roles.subject_mismatch';
    const verifiedA = await authVerifier.verifyAccessToken(tokenA);
    if (!verifiedA.ok) throw new ProofFailure('roles.auth_context');
    const databaseCallCount = database.getUserScopedCallCount();
    let mismatchDenied = false;
    try {
      await composition.loadFreshRoles({ ...verifiedA.value, userId: fixtureB.credentials.userId });
    } catch {
      mismatchDenied = true;
    }
    assertCheck(
      checks,
      'roles_subject_mismatch_denied_without_db',
      mismatchDenied && database.getUserScopedCallCount() === databaseCallCount,
      { count: database.getUserScopedCallCount() - databaseCallCount },
    );

    phase = 'roles.metadata_snapshot';
    const originalAccount = await adminRequest(input, 'GET', input.fixtureA.userId);
    metadataSnapshot = adminAppMetadata(originalAccount);
    const originalRoles = Array.isArray(metadataSnapshot.roles)
      ? metadataSnapshot.roles.filter((role): role is string => typeof role === 'string')
      : [];
    const temporaryRole = `w4_probe_${randomBytes(3).toString('hex')}`;
    if (!ROLE_PATTERN.test(temporaryRole)) throw new ProofFailure('roles.temporary_name');
    const updatedRoles = [...originalRoles.filter((role) => role !== temporaryRole), temporaryRole];
    if (updatedRoles.length > 10) updatedRoles.splice(0, updatedRoles.length - 10);
    const updatedMetadata = { ...metadataSnapshot, roles: updatedRoles };

    phase = 'roles.metadata_update';
    metadataUpdateAttempted = true;
    await adminRequest(input, 'PUT', input.fixtureA.userId, { app_metadata: updatedMetadata });
    assertCheck(checks, 'roles.metadata_updated', true);

    phase = 'roles.fresh_read';
    const freshRoles = await composition.loadFreshRoles(verifiedA.value);
    assertCheck(
      checks,
      'roles_old_jwt_reads_fresh_db_roles',
      !verifiedA.value.appRoles.includes(temporaryRole) && freshRoles.includes(temporaryRole),
      { count: freshRoles.length },
    );

    failedCheck = undefined;
  } catch (error) {
    failedCheck = error instanceof ProofFailure ? error.checkName : phase;
  } finally {
    if (metadataUpdateAttempted && metadataSnapshot !== undefined) {
      try {
        await adminRequest(input, 'PUT', input.fixtureA.userId, {
          app_metadata: metadataSnapshot,
        });
        const restoredAccount = await adminRequest(input, 'GET', input.fixtureA.userId);
        metadataRestored = isDeepStrictEqual(adminAppMetadata(restoredAccount), metadataSnapshot);
      } catch {
        metadataRestored = false;
      }
    }
    addCleanupCheck(checks, 'cleanup.account_a_metadata_restored', metadataRestored);

    let fixtureCleanupPassed = true;
    for (const userId of createdUsers) {
      try {
        await adminRequest(input, 'DELETE', userId);
      } catch {
        fixtureCleanupPassed = false;
      }
    }
    addCleanupCheck(checks, 'cleanup.owned_fixtures_removed', fixtureCleanupPassed);

    if (database) {
      try {
        await database.destroy();
      } catch {
        addCleanupCheck(checks, 'cleanup.database_closed', false);
      }
    }
  }

  const cleanupFailed = checks.some((check) => check.name.startsWith('cleanup.') && !check.passed);
  return {
    passed: failedCheck === undefined && !cleanupFailed,
    checks,
    ...(failedCheck === undefined ? {} : { failedCheck }),
  };
}

async function main(): Promise<void> {
  let result: SafeProofResult;
  try {
    const rawInput = readFileSync(0, 'utf8');
    const input = parseInput(JSON.parse(rawInput) as unknown);
    result = await runProof(input);
  } catch {
    result = { passed: false, checks: [], failedCheck: 'preflight.invalid_inputs' };
  }
  process.stdout.write(`${REPORT_MARKER}${JSON.stringify(result)}\n`);
  if (!result.passed) process.exitCode = 1;
}

void main();
