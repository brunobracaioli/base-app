import { spawnSync } from 'node:child_process';
import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const supabaseBin = process.env.SUPABASE_CLI || 'supabase';
const credentialsPath = process.env.W4_AUTH_SPIKE_SECRET_FILE || null;
const initialRoles = ['member'];
const refreshedRoles = ['member', 'reviewer'];
const progress = {
  localStatusRead: false,
  fixtureReady: false,
  adminRequestAccepted: false,
  userIdReturned: false,
  credentialFileWritten: false,
  passwordSignIn: false,
  jwksRead: false,
  initialClaimsVerified: false,
  adminMetadataUpdate: false,
  metadataUpdated: false,
  tokenRefresh: false,
  refreshedClaimsVerified: false,
  fixtureRestored: false,
};

function loadLocalStatus() {
  const result = spawnSync(supabaseBin, ['status', '--workdir', repositoryRoot, '--output', 'json'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1' },
  });

  if (result.status !== 0 || result.error) throw new Error('status');

  const status = JSON.parse(result.stdout);
  const apiUrl = status.API_URL || status.api_url;
  const anonymousKey = status.ANON_KEY || status.anon_key;
  const serviceRoleKey = status.SERVICE_ROLE_KEY || status.service_role_key;
  if (typeof apiUrl !== 'string' || typeof anonymousKey !== 'string' || typeof serviceRoleKey !== 'string')
    throw new Error('status_shape');

  const parsedUrl = new URL(apiUrl);
  if (
    parsedUrl.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(parsedUrl.hostname) ||
    parsedUrl.pathname !== '/' ||
    parsedUrl.search !== '' ||
    parsedUrl.hash !== ''
  ) {
    throw new Error('api_url');
  }

  return { apiUrl: apiUrl.replace(/\/$/, ''), anonymousKey, serviceRoleKey };
}

function persistCredentials(credentials) {
  if (!credentialsPath) return;
  if (!path.isAbsolute(credentialsPath)) throw new Error('secret_path');

  const resolved = path.resolve(credentialsPath);
  if (resolved === repositoryRoot || resolved.startsWith(`${repositoryRoot}${path.sep}`))
    throw new Error('secret_inside_checkout');

  mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  writeFileSync(resolved, `${JSON.stringify(credentials)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  if ((statSync(resolved).mode & 0o077) !== 0) throw new Error('secret_permissions');
}

function readCredentials() {
  if (!credentialsPath || !existsSync(credentialsPath)) {
    return {
      email: `${randomBytes(18).toString('hex')}@example.invalid`,
      password: randomBytes(32).toString('hex'),
    };
  }

  const resolved = path.resolve(credentialsPath);
  if (!path.isAbsolute(credentialsPath) || resolved.startsWith(`${repositoryRoot}${path.sep}`))
    throw new Error('secret_path');
  if ((statSync(resolved).mode & 0o077) !== 0) throw new Error('secret_permissions');

  const credentials = JSON.parse(readFileSync(resolved, 'utf8'));
  if (
    credentials === null ||
    typeof credentials !== 'object' ||
    typeof credentials.email !== 'string' ||
    typeof credentials.password !== 'string' ||
    (credentials.userId !== undefined && typeof credentials.userId !== 'string')
  ) {
    throw new Error('secret_shape');
  }
  return credentials;
}

async function requestJson(url, { method = 'GET', apiKey, bearer, body } = {}) {
  const headers = { apikey: apiKey, accept: 'application/json' };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
    cache: 'no-store',
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    throw new Error('response_json');
  }
  if (!response.ok) throw new Error('http');
  return payload;
}

async function createOrResetUser(apiUrl, serviceRoleKey, credentials) {
  if (credentials.userId) {
    await requestJson(`${apiUrl}/auth/v1/admin/users/${encodeURIComponent(credentials.userId)}`, {
      method: 'PUT',
      apiKey: serviceRoleKey,
      bearer: serviceRoleKey,
      body: {
        password: credentials.password,
        app_metadata: { roles: initialRoles },
      },
    });
    progress.adminMetadataUpdate = true;
    return credentials;
  }

  const user = await requestJson(`${apiUrl}/auth/v1/admin/users`, {
    method: 'POST',
    apiKey: serviceRoleKey,
    bearer: serviceRoleKey,
    body: {
      email: credentials.email,
      password: credentials.password,
      email_confirm: true,
      app_metadata: { roles: initialRoles },
    },
  });
  progress.adminRequestAccepted = true;
  if (typeof user.id !== 'string') throw new Error('user_id');
  progress.userIdReturned = true;
  progress.adminMetadataUpdate = true;

  const persisted = { ...credentials, userId: user.id };
  persistCredentials(persisted);
  progress.credentialFileWritten = credentialsPath !== null;
  return persisted;
}

function decodeBase64Url(value) {
  return Buffer.from(value, 'base64url');
}

function decodeJsonSegment(segment) {
  return JSON.parse(decodeBase64Url(segment).toString('utf8'));
}

function verifyAccessToken(token, jwks, apiUrl) {
  if (typeof token !== 'string') throw new Error('access_token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('jwt_shape');

  const header = decodeJsonSegment(parts[0]);
  const payload = decodeJsonSegment(parts[1]);
  if (!['ES256', 'RS256'].includes(header.alg) || typeof header.kid !== 'string')
    throw new Error('jwt_header');

  const keys = jwks?.keys;
  if (!Array.isArray(keys)) throw new Error('jwks_shape');
  const jwk = keys.find((key) => key?.kid === header.kid);
  if (!jwk || (jwk.alg && jwk.alg !== header.alg) || (jwk.use && jwk.use !== 'sig'))
    throw new Error('jwks_key');
  if (Array.isArray(jwk.key_ops) && !jwk.key_ops.includes('verify')) throw new Error('jwks_ops');

  const isPublicOnly = !['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'].some((name) => name in jwk);
  const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
  const signedContent = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature = decodeBase64Url(parts[2]);
  const signatureValid =
    header.alg === 'ES256'
      ? verify('sha256', signedContent, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature)
      : verify('RSA-SHA256', signedContent, publicKey, signature);
  if (!signatureValid) throw new Error('signature');

  const authMetadata = payload.app_metadata;
  if (authMetadata === null || typeof authMetadata !== 'object' || Array.isArray(authMetadata))
    throw new Error('app_metadata');

  const amr = payload.amr;
  const amrPasswordMethodPresent =
    Array.isArray(amr) && amr.some((entry) => entry?.method === 'password');
  const amrTimestampsValid =
    Array.isArray(amr) &&
    amr.length > 0 &&
    amr.every((entry) => Number.isFinite(entry?.timestamp) && entry.timestamp > 0);
  const roles = authMetadata.roles;
  const providers = authMetadata.providers;

  return {
    header,
    payload,
    authMetadata,
    aud: payload.aud,
    alg: header.alg,
    issuerMatches: payload.iss === `${apiUrl}/auth/v1`,
    audienceMatches: payload.aud === 'authenticated',
    roleClaimMatches: payload.role === 'authenticated',
    signatureValid,
    jwksKeyCount: keys.length,
    jwksPublicOnly: isPublicOnly,
    amrPasswordMethodPresent,
    amrTimestampsValid,
    amrEntryCount: Array.isArray(amr) ? amr.length : 0,
    isAnonymousPresent: Object.hasOwn(payload, 'is_anonymous'),
    isAnonymousFalse: payload.is_anonymous === false || !Object.hasOwn(payload, 'is_anonymous'),
    roles: Array.isArray(roles) && roles.every((item) => typeof item === 'string') ? roles : null,
    providers:
      Array.isArray(providers) && providers.every((item) => typeof item === 'string')
        ? providers
        : null,
    topLevelClaimNames: Object.keys(payload).sort(),
    appMetadataClaimNames: Object.keys(authMetadata).sort(),
  };
}

function exactValues(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    expected.every((value) => actual.includes(value))
  );
}

async function main() {
  const { apiUrl, anonymousKey, serviceRoleKey } = loadLocalStatus();
  progress.localStatusRead = true;
  const credentials = await createOrResetUser(apiUrl, serviceRoleKey, readCredentials());
  progress.fixtureReady = true;

  const initialSession = await requestJson(`${apiUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    apiKey: anonymousKey,
    body: { email: credentials.email, password: credentials.password },
  });
  progress.passwordSignIn = true;
  const jwks = await requestJson(`${apiUrl}/auth/v1/.well-known/jwks.json`, {
    apiKey: anonymousKey,
  });
  progress.jwksRead = true;
  const initial = verifyAccessToken(initialSession.access_token, jwks, apiUrl);

  if (
    !initial.issuerMatches ||
    !initial.audienceMatches ||
    !initial.roleClaimMatches ||
    !initial.signatureValid ||
    !initial.jwksPublicOnly ||
    !initial.amrPasswordMethodPresent ||
    !initial.amrTimestampsValid ||
    !initial.isAnonymousFalse ||
    !exactValues(initial.roles, initialRoles) ||
    !exactValues(initial.providers, ['email'])
  ) {
    throw new Error('initial_claims');
  }
  progress.initialClaimsVerified = true;

  await requestJson(
    `${apiUrl}/auth/v1/admin/users/${encodeURIComponent(initial.payload.sub)}`,
    {
      method: 'PUT',
      apiKey: serviceRoleKey,
      bearer: serviceRoleKey,
      body: { app_metadata: { roles: refreshedRoles } },
    },
  );
  progress.metadataUpdated = true;

  const refreshedSession = await requestJson(`${apiUrl}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    apiKey: anonymousKey,
    body: { refresh_token: initialSession.refresh_token },
  });
  progress.tokenRefresh = true;
  const refreshed = verifyAccessToken(refreshedSession.access_token, jwks, apiUrl);
  const rolesChangedAfterRefresh =
    exactValues(initial.roles, initialRoles) && exactValues(refreshed.roles, refreshedRoles);
  const providersPersistedAfterRefresh =
    exactValues(initial.providers, ['email']) && exactValues(refreshed.providers, ['email']);

  if (
    !refreshed.issuerMatches ||
    !refreshed.audienceMatches ||
    !refreshed.roleClaimMatches ||
    !refreshed.signatureValid ||
    !refreshed.jwksPublicOnly ||
    !rolesChangedAfterRefresh ||
    !providersPersistedAfterRefresh ||
    !refreshed.isAnonymousFalse
  ) {
    throw new Error('refresh_claims');
  }
  progress.refreshedClaimsVerified = true;

  await requestJson(
    `${apiUrl}/auth/v1/admin/users/${encodeURIComponent(refreshed.payload.sub)}`,
    {
      method: 'PUT',
      apiKey: serviceRoleKey,
      bearer: serviceRoleKey,
      body: { app_metadata: { roles: initialRoles } },
    },
  );
  progress.fixtureRestored = true;

  return {
    ok: true,
    flow: {
      adminFixtureProvisioned: true,
      realPasswordSignIn: true,
      realRefresh: true,
      fixtureRestored: true,
      smtpUsed: false,
    },
    algorithm: initial.alg,
    refreshedAlgorithm: refreshed.alg,
    audience: initial.aud,
    issuerMatches: initial.issuerMatches && refreshed.issuerMatches,
    roleClaimMatches: initial.roleClaimMatches && refreshed.roleClaimMatches,
    signatureVerifiedAgainstJwks: initial.signatureValid && refreshed.signatureValid,
    jwks: { publicOnly: initial.jwksPublicOnly && refreshed.jwksPublicOnly, keyCount: initial.jwksKeyCount },
    claimNames: initial.topLevelClaimNames,
    appMetadataClaimNames: initial.appMetadataClaimNames,
    claims: {
      rolesPresent: initial.roles !== null && refreshed.roles !== null,
      providersPresent: initial.providers !== null && refreshed.providers !== null,
      initialRoleCount: initial.roles.length,
      refreshedRoleCount: refreshed.roles.length,
      initialProviderCount: initial.providers.length,
      refreshedProviderCount: refreshed.providers.length,
      rolesChangedAfterRefresh,
      providersPersistedAfterRefresh,
      isAnonymousFalse: initial.isAnonymousFalse && refreshed.isAnonymousFalse,
      isAnonymousClaimPresent: initial.isAnonymousPresent,
      amrPasswordMethodPresent: initial.amrPasswordMethodPresent,
      amrEntryCount: initial.amrEntryCount,
      amrTimestampsValid: initial.amrTimestampsValid,
    },
  };
}

main()
  .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
  .catch(() => {
    process.stdout.write(`${JSON.stringify({ ok: false, progress })}\n`);
    process.exitCode = 1;
  });
