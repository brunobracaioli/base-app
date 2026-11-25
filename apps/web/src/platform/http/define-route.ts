import { createHash } from 'node:crypto';
import * as z from 'zod';
import { metric } from '@vercel/functions';

import type { AuthFailure, AuthVerificationResult } from '../auth/types';
import type {
  AuthorizationDecision,
  AuthorizationPolicy,
  AuthorizationRequest,
  AuthContext,
  UserAuthContext,
} from '../authorization/types';
import { ipAddress } from './ip-address';
import { readBoundedBody, parseJsonBody } from './body';
import { HttpProblem, problemResponse } from './problem';
import { applySecurityHeaders } from './security-headers';
import { createDefaultRouteDependencies } from './runtime';
import { isUuid, UUID_V7_PATTERN } from './request-id';
import type {
  DefineRouteInput,
  IdempotencyAcquireResult,
  ParsedRouteInput,
  RouteDependencies,
  RouteHandlerContext,
  RouteInputSchemas,
} from './types';
import type { RateLimitConfig } from './types';

const PUBLIC_APP_CONFIG_CACHE_CONTROL =
  'public, s-maxage=60, stale-while-revalidate=60' as const;
const DEFAULT_BODY_LIMIT = 32 * 1024;
const MAX_BODY_LIMIT = 1024 * 1024;
const DEFAULT_USER_IP_LIMIT = 120;
const DEFAULT_WEBHOOK_IP_LIMIT = 60;
const DEFAULT_POLICY_TIMEOUT_MS = 500;
const MAX_REPLAY_BODY_BYTES = 65_536;
const operationIdPattern = /^[A-Za-z][A-Za-z0-9]*$/;
const stableCodePattern = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/;

function validateRouteDefinition<Schemas extends RouteInputSchemas, Output>(
  definition: DefineRouteInput<Schemas, Output>,
  dependencies: RouteDependencies,
): void {
  if (!operationIdPattern.test(definition.operationId)) {
    throw new TypeError('Route operationId must be a stable OpenAPI identifier.');
  }
  if (
    !Number.isSafeInteger(definition.rateLimit.limit) ||
    definition.rateLimit.limit < 1 ||
    !Number.isSafeInteger(definition.rateLimit.windowSec) ||
    definition.rateLimit.windowSec < 1
  ) {
    throw new TypeError('Route rate limit must use positive integer limits and windows.');
  }
  if (
    definition.rateLimit.ipLimit !== undefined &&
    (!Number.isSafeInteger(definition.rateLimit.ipLimit) || definition.rateLimit.ipLimit < 1)
  ) {
    throw new TypeError('Route IP rate limit must be a positive integer.');
  }

  const maxBodyBytes = definition.maxBodyBytes ?? DEFAULT_BODY_LIMIT;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > MAX_BODY_LIMIT) {
    throw new TypeError('Route maxBodyBytes must be between 1 byte and 1 MB.');
  }

  const policies = definition.authorize ?? [];
  if (new Set(policies).size !== policies.length)
    throw new TypeError('Route authorization policies must be unique.');
  if (definition.auth.kind === 'public' && policies.length > 0) {
    throw new TypeError('Public routes cannot declare user authorization policies.');
  }
  if (
    definition.auth.kind === 'webhook' &&
    !/^[a-z][a-z0-9-]{0,47}$/.test(definition.auth.provider)
  ) {
    throw new TypeError('Webhook provider name is invalid.');
  }
  if (definition.idempotency === 'required' && definition.auth.kind !== 'user') {
    throw new TypeError('Idempotency requires a user-authenticated route.');
  }
  if (
    definition.successStatus !== undefined &&
    definition.successStatus !== 200 &&
    definition.successStatus !== 204
  ) {
    throw new TypeError('Route successStatus must be 200 or 204.');
  }
  if (definition.successStatus === 204) {
    const noContentOutput = definition.output.safeParse(undefined);
    if (!noContentOutput.success || noContentOutput.data !== undefined) {
      throw new TypeError('A 204 route output schema must validate to undefined.');
    }
  }
  if (
    definition.cachePolicy === 'public-app-config' &&
    (definition.operationId !== 'getAppConfig' ||
      definition.auth.kind !== 'public' ||
      definition.successStatus === 204)
  ) {
    throw new TypeError('Public app-config caching is restricted to its public 200 route.');
  }

  if (definition.destructive && definition.auth.kind !== 'user') {
    throw new TypeError('Destructive routes require user authentication.');
  }

  if (definition.maintenance === 'exempt' && definition.auth.kind !== 'webhook') {
    const hasOperatorPolicy = policies.some(
      (name) => dependencies.authorizationPolicies.get(name)?.operator === true,
    );
    if (!hasOperatorPolicy) {
      throw new TypeError(
        'Maintenance exemption requires a webhook or operator authorization policy.',
      );
    }
  }
}

function createResponse(
  body: unknown,
  status: number,
  requestId: string,
  headers?: HeadersInit,
  cacheControl?: string,
): Response {
  const responseHeaders = new Headers(headers);
  if (status !== 204) responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
  responseHeaders.set('X-Request-Id', requestId);
  responseHeaders.set('Cache-Control', cacheControl ?? 'no-store');
  const responseBody = status === 204 ? null : (JSON.stringify(body) ?? 'null');
  const response = applySecurityHeaders(
    new Response(responseBody, { status, headers: responseHeaders }),
  );
  if (cacheControl !== undefined) response.headers.set('Cache-Control', cacheControl);
  return response;
}

function authFailureProblem(error: AuthFailure): HttpProblem {
  if (error.code === 'auth.unavailable') {
    const retryAfter = error.retryAfterSec;
    const retryAfterSec =
      retryAfter !== undefined && Number.isSafeInteger(retryAfter) && retryAfter > 0
        ? retryAfter
        : 5;
    return new HttpProblem(503, error.code, 'Authentication is temporarily unavailable.', {
      'Retry-After': String(retryAfterSec),
    });
  }
  return new HttpProblem(401, error.code, 'Authentication failed.');
}

function errorName(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    typeof error.name === 'string'
    ? error.name
    : 'Error';
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

function safeErrorFields(error: unknown): {
  readonly errorName: string;
  readonly sqlState?: string;
} {
  const fields: { errorName: string; sqlState?: string } = { errorName: errorName(error) };
  const code = errorCode(error);
  if (code && /^[0-9A-Z]{5}$/.test(code)) fields.sqlState = code;
  return fields;
}

function parseSchema<Schema extends z.ZodType>(schema: Schema, value: unknown): z.output<Schema> {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new HttpProblem(400, 'validation.failed', 'Request validation failed.');
  return result.data;
}

function queryObject(request: Request): Record<string, unknown> {
  const query: Record<string, unknown> = {};
  for (const [key, value] of new URL(request.url).searchParams) {
    const existing = query[key];
    query[key] =
      existing === undefined
        ? value
        : Array.isArray(existing)
          ? [...existing, value]
          : [existing, value];
  }
  return query;
}

function selectedHeaders(request: Request, schema: z.ZodType): Record<string, unknown> {
  if (!(schema instanceof z.ZodObject)) return {};
  const selected: Record<string, unknown> = {};
  for (const key of Object.keys(schema.shape)) selected[key] = request.headers.get(key);
  return selected;
}

function parseRouteInput<Schemas extends RouteInputSchemas>(
  schemas: Schemas | undefined,
  request: Request,
  rawBody: Uint8Array,
): ParsedRouteInput<Schemas> {
  const bodySchema = schemas?.body;
  if (!bodySchema && rawBody.byteLength > 0) {
    throw new HttpProblem(400, 'request.unexpected_body', 'Request body is not accepted.');
  }
  const parsedBody = bodySchema ? parseSchema(bodySchema, parseJsonBody(rawBody)) : undefined;
  const parsedQuery = schemas?.query ? parseSchema(schemas.query, queryObject(request)) : undefined;
  const parsedHeaders = schemas?.headers
    ? parseSchema(schemas.headers, selectedHeaders(request, schemas.headers))
    : undefined;
  return {
    body: parsedBody,
    query: parsedQuery,
    headers: parsedHeaders,
  } as ParsedRouteInput<Schemas>;
}

function authToken(request: Request): string | null {
  const value = request.headers.get('authorization');
  if (!value) return null;
  const match = /^Bearer\s+([^\s]+)$/i.exec(value);
  return match?.[1] ?? null;
}

function recentAuthenticationPassed(auth: UserAuthContext, now: Date, maxAgeSec: number): boolean {
  if (auth.amr.length === 0) return false;
  const latestTimestamp = Math.max(...auth.amr.map((entry) => entry.timestamp));
  const ageSec = now.getTime() / 1_000 - latestTimestamp;
  return Number.isFinite(ageSec) && ageSec >= 0 && ageSec <= maxAgeSec;
}

function rateBucket(
  operationId: string,
  key: RateLimitConfig['key'],
  auth: AuthContext | null,
  ip: string,
): string {
  if (key === 'global') return `${operationId}:global`;
  if (key === 'ip') return `${operationId}:ip:${ip}`;
  if (auth?.kind !== 'user')
    throw new HttpProblem(401, 'auth.required', 'Authentication is required.');
  return `${operationId}:user:${auth.userId}`;
}

async function enforceRateLimit(
  dependencies: RouteDependencies,
  input: {
    readonly operationId: string;
    readonly policy: RateLimitConfig;
    readonly auth: AuthContext | null;
    readonly ip: string;
    readonly now: Date;
    readonly responseHeaders: Headers;
  },
): Promise<void> {
  const bucket = rateBucket(input.operationId, input.policy.key, input.auth, input.ip);
  let result;
  try {
    result = await dependencies.rateLimiter.consume({
      bucket,
      limit: input.policy.limit,
      windowSec: input.policy.windowSec,
      nowMs: input.now.getTime(),
    });
  } catch (error) {
    dependencies.logger.error('Rate limit store request failed', {
      route: input.operationId,
      ...safeErrorFields(error),
    });
    if (input.policy.onStoreFailure === 'closed') {
      throw new HttpProblem(503, 'ratelimit.unavailable', 'Request could not be processed.');
    }
    input.responseHeaders.set('x-rate-limit-failure', 'open');
    return;
  }

  if (!result.allowed) {
    const retryAfter = Math.max(1, Math.ceil((result.resetAtMs - input.now.getTime()) / 1_000));
    throw new HttpProblem(429, 'ratelimit.exceeded', 'Too many requests.', {
      'Retry-After': String(retryAfter),
    });
  }
}

async function enforceUserIpLimit(
  dependencies: RouteDependencies,
  input: {
    readonly operationId: string;
    readonly limit: number;
    readonly auth: UserAuthContext;
    readonly ip: string;
    readonly now: Date;
    readonly onStoreFailure: RateLimitConfig['onStoreFailure'];
    readonly responseHeaders: Headers;
  },
): Promise<void> {
  await enforceRateLimit(dependencies, {
    operationId: input.operationId,
    policy: {
      key: 'ip',
      limit: input.limit,
      windowSec: 60,
      onStoreFailure: input.onStoreFailure,
    },
    auth: input.auth,
    ip: input.ip,
    now: input.now,
    responseHeaders: input.responseHeaders,
  });
}

function isDecision(value: unknown): value is AuthorizationDecision {
  if (typeof value !== 'object' || value === null || !('allow' in value)) return false;
  if (value.allow === true) return true;
  if (value.allow !== false || !('status' in value) || !('code' in value)) return false;
  return (
    (value.status === 401 || value.status === 403 || value.status === 404) &&
    typeof value.code === 'string' &&
    stableCodePattern.test(value.code)
  );
}

async function withPolicyTimeout(
  policy: AuthorizationPolicy,
  request: AuthorizationRequest,
): Promise<AuthorizationDecision> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error('Authorization policy timed out.')),
      DEFAULT_POLICY_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([policy(request), timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function recordPolicyError(
  dependencies: RouteDependencies,
  input: {
    readonly policyName: string;
    readonly operationId: string;
    readonly requestId: string;
    readonly auth: AuthContext | null;
    readonly error: unknown;
  },
): Promise<void> {
  try {
    await dependencies.recordSecurityEvent({
      action: 'security.authorization_policy_error',
      actorType: 'system',
      actorRef: null,
      subjectRef: input.auth?.kind === 'user' ? input.auth.userId : null,
      resourceType: 'api_route',
      resourceRef: input.operationId,
      outcome: 'failed',
      correlationId: input.requestId,
      metadata: {
        policy: input.policyName,
        errorType: errorName(input.error),
        ...(() => {
          const code = errorCode(input.error);
          return code && /^[0-9A-Z]{5}$/.test(code) ? { databaseState: code } : {};
        })(),
      },
    });
  } catch (auditError) {
    dependencies.logger.error('Security audit write failed', {
      route: input.operationId,
      ...safeErrorFields(auditError),
    });
  }
}

async function enforceAuthorization(
  dependencies: RouteDependencies,
  input: {
    readonly names: readonly string[];
    readonly auth: AuthContext | null;
    readonly request: Request;
    readonly operationId: string;
    readonly requestId: string;
    readonly now: Date;
    readonly destructive: boolean;
  },
): Promise<void> {
  if (input.names.length === 0 && !input.destructive) return;
  const auth = input.auth;
  if (auth?.kind !== 'user')
    throw new HttpProblem(401, 'auth.required', 'Authentication is required.');

  let freshRolesPromise: Promise<readonly string[]> | undefined;
  const loadFreshRoles = (): Promise<readonly string[]> => {
    freshRolesPromise ??= dependencies.loadFreshRoles(auth);
    return freshRolesPromise;
  };
  if (input.destructive) {
    try {
      await loadFreshRoles();
    } catch (error) {
      await recordPolicyError(dependencies, {
        policyName: 'loadFreshRoles',
        operationId: input.operationId,
        requestId: input.requestId,
        auth,
        error,
      });
      throw new HttpProblem(403, 'authz.policy_error', 'Request is not authorized.');
    }
  }

  for (const name of input.names) {
    const registered = dependencies.authorizationPolicies.get(name);
    if (!registered) {
      const error = new Error('Authorization policy is not registered.');
      await recordPolicyError(dependencies, {
        policyName: name,
        operationId: input.operationId,
        requestId: input.requestId,
        auth,
        error,
      });
      throw new HttpProblem(403, 'authz.policy_error', 'Request is not authorized.');
    }

    const authorizationRequest: AuthorizationRequest = {
      auth,
      host: new URL(input.request.url).host.toLowerCase(),
      method: input.request.method.toUpperCase(),
      path: new URL(input.request.url).pathname,
      now: input.now,
      loadFreshRoles,
    };

    let decision: AuthorizationDecision;
    try {
      decision = await withPolicyTimeout(registered.policy, authorizationRequest);
      if (!isDecision(decision)) throw new Error('Authorization policy did not decide.');
    } catch (error) {
      await recordPolicyError(dependencies, {
        policyName: name,
        operationId: input.operationId,
        requestId: input.requestId,
        auth,
        error,
      });
      throw new HttpProblem(403, 'authz.policy_error', 'Request is not authorized.');
    }

    if (decision.allow) continue;
    throw new HttpProblem(decision.status, decision.code, 'Request is not authorized.');
  }
}

function requestHash(request: Request, rawBody: Uint8Array): string {
  const url = new URL(request.url);
  return createHash('sha256')
    .update(`${request.method.toUpperCase()}\n${url.pathname}${url.search}\n`, 'utf8')
    .update(rawBody)
    .digest('hex');
}

function encodeBody(body: unknown): { readonly text: string; readonly byteLength: number } {
  const text = JSON.stringify(body) ?? 'null';
  return { text, byteLength: Buffer.byteLength(text, 'utf8') };
}

async function claimIdempotency(
  dependencies: RouteDependencies,
  input: {
    readonly userId: string;
    readonly key: string;
    readonly requestHash: string;
    readonly now: Date;
    readonly output: z.ZodType;
    readonly requestId: string;
  },
): Promise<
  | { readonly kind: 'acquired'; readonly leaseUntil: Date }
  | { readonly kind: 'replay'; readonly response: Response }
> {
  let result: IdempotencyAcquireResult;
  try {
    result = await dependencies.idempotencyStore.acquire({
      userId: input.userId,
      key: input.key,
      requestHash: input.requestHash,
      now: input.now,
      leaseUntil: new Date(input.now.getTime() + 60_000),
      expiresAt: new Date(input.now.getTime() + 24 * 60 * 60 * 1_000),
    });
  } catch (error) {
    dependencies.logger.error('Idempotency claim failed', safeErrorFields(error));
    throw new HttpProblem(503, 'idempotency.unavailable', 'Request could not be processed.');
  }

  if (result.kind === 'acquired') return result;
  if (result.kind === 'in_progress') {
    throw new HttpProblem(409, 'idempotency.in_progress', 'Request with this key is in progress.');
  }
  if (result.kind === 'key_reused') {
    throw new HttpProblem(
      409,
      'idempotency.key_reused',
      'Idempotency key was used for a different request.',
    );
  }
  if (result.response.status < 200 || result.response.status >= 300) {
    throw new HttpProblem(500, 'internal.error', 'An unexpected error occurred.');
  }

  const body =
    result.response.status === 204
      ? input.output.parse(undefined)
      : process.env.NODE_ENV === 'production'
        ? result.response.body
        : input.output.parse(result.response.body);
  if (result.response.status === 204 && body !== undefined) {
    throw new HttpProblem(500, 'internal.error', 'An unexpected error occurred.');
  }
  return {
    kind: 'replay',
    response: createResponse(body, result.response.status, input.requestId),
  };
}

async function releaseIdempotency(
  dependencies: RouteDependencies,
  input: {
    readonly userId: string;
    readonly key: string;
    readonly requestHash: string;
    readonly leaseUntil: Date;
    readonly operationId: string;
  },
): Promise<void> {
  try {
    await dependencies.idempotencyStore.release(input);
  } catch (error) {
    dependencies.logger.error('Idempotency lease release failed', {
      route: input.operationId,
      ...safeErrorFields(error),
    });
  }
}

export function createDefineRoute(dependencies: RouteDependencies) {
  if (
    !Number.isInteger(dependencies.recentAuthMaxAgeSec) ||
    dependencies.recentAuthMaxAgeSec < 60 ||
    dependencies.recentAuthMaxAgeSec > 900
  ) {
    throw new TypeError('recentAuthMaxAgeSec must be an integer between 60 and 900.');
  }
  return function defineRoute<Schemas extends RouteInputSchemas, Output>(
    definition: DefineRouteInput<Schemas, Output>,
  ): (request: Request) => Promise<Response> {
    validateRouteDefinition(definition, dependencies);
    const successStatus = definition.successStatus ?? 200;
    const maxBodyBytes = definition.maxBodyBytes ?? DEFAULT_BODY_LIMIT;
    const maintenance = definition.maintenance ?? 'block';
    const isIdempotent = definition.idempotency === 'required';

    return async function routeHandler(request: Request): Promise<Response> {
      const startedAt = performance.now();
      const requestId = dependencies.requestId();
      const clientRequestId = isUuid(request.headers.get('x-request-id'))
        ? request.headers.get('x-request-id')
        : null;
      const now = dependencies.now();
      const responseHeaders = new Headers();
      let outcome = 'error';
      let authenticatedUserId: string | undefined;
      let idempotencyLease:
        | {
            readonly userId: string;
            readonly key: string;
            readonly requestHash: string;
            readonly leaseUntil: Date;
          }
        | undefined;

      try {
        if (!UUID_V7_PATTERN.test(requestId)) throw new Error('Server request ID is not a UUIDv7.');

        const gate = await dependencies.checkVersionAndMaintenance({
          request,
          operationId: definition.operationId,
          maintenance,
        });
        if (!gate.allow) {
          throw new HttpProblem(
            gate.status,
            gate.code,
            gate.title,
            gate.retryAfterSec === undefined
              ? undefined
              : { 'Retry-After': String(gate.retryAfterSec) },
          );
        }

        let auth: AuthContext | null = null;
        const ip = ipAddress(request);
        let rawBody: Uint8Array | undefined;

        if (definition.auth.kind === 'webhook') {
          const ipLimit = definition.rateLimit.ipLimit ?? DEFAULT_WEBHOOK_IP_LIMIT;
          await enforceRateLimit(dependencies, {
            operationId: definition.operationId,
            policy: {
              key: 'ip',
              limit: ipLimit,
              windowSec: 60,
              onStoreFailure: definition.rateLimit.onStoreFailure,
            },
            auth: null,
            ip,
            now,
            responseHeaders,
          });
          rawBody = await readBoundedBody(request, maxBodyBytes);
          const verified = await definition.auth.verifier({ request, body: rawBody, now });
          if (!verified) throw new HttpProblem(401, 'auth.invalid', 'Authentication failed.');
          auth = { kind: 'webhook', provider: definition.auth.provider };
        } else if (definition.auth.kind === 'user') {
          const authorizationHeader = request.headers.get('authorization');
          if (authorizationHeader === null) {
            throw new HttpProblem(401, 'auth.missing_token', 'Authentication is required.');
          }
          const token = authToken(request);
          if (!token) throw new HttpProblem(401, 'auth.invalid_token', 'Authentication failed.');
          let verification: AuthVerificationResult;
          try {
            verification = await dependencies.authenticateUser(token, request);
          } catch (error) {
            dependencies.logger.error('Authentication verifier failed', {
              route: definition.operationId,
              ...safeErrorFields(error),
            });
            throw authFailureProblem({ code: 'auth.unavailable' });
          }
          if (!verification.ok) throw authFailureProblem(verification.error);
          auth = verification.value;
          authenticatedUserId = verification.value.userId;
        }

        await enforceRateLimit(dependencies, {
          operationId: definition.operationId,
          policy: definition.rateLimit,
          auth,
          ip,
          now,
          responseHeaders,
        });

        if (auth?.kind === 'user') {
          await enforceUserIpLimit(dependencies, {
            operationId: definition.operationId,
            limit: definition.rateLimit.ipLimit ?? DEFAULT_USER_IP_LIMIT,
            auth,
            ip,
            now,
            onStoreFailure: definition.rateLimit.onStoreFailure,
            responseHeaders,
          });
        }

        if (
          auth?.kind === 'user' &&
          ((definition.auth.kind === 'user' && definition.auth.requireRecentAuth === true) ||
            definition.destructive === true)
        ) {
          if (!recentAuthenticationPassed(auth, now, dependencies.recentAuthMaxAgeSec)) {
            throw new HttpProblem(
              401,
              'auth.recent_auth_required',
              'Recent authentication is required.',
            );
          }
        }

        await enforceAuthorization(dependencies, {
          names: definition.authorize ?? [],
          auth,
          request,
          operationId: definition.operationId,
          requestId,
          now,
          destructive: definition.destructive === true,
        });

        if (rawBody === undefined) rawBody = await readBoundedBody(request, maxBodyBytes);
        const input = parseRouteInput(definition.input, request, rawBody);

        if (isIdempotent) {
          if (auth?.kind !== 'user')
            throw new HttpProblem(401, 'auth.required', 'Authentication is required.');
          const key = request.headers.get('idempotency-key');
          if (!isUuid(key))
            throw new HttpProblem(
              400,
              'idempotency.key_required',
              'A valid Idempotency-Key is required.',
            );
          const hash = requestHash(request, rawBody);
          const claim = await claimIdempotency(dependencies, {
            userId: auth.userId,
            key,
            requestHash: hash,
            now,
            output: definition.output,
            requestId,
          });
          if (claim.kind === 'replay') {
            outcome = 'replay';
            return applySecurityHeaders(claim.response);
          }
          idempotencyLease = {
            userId: auth.userId,
            key,
            requestHash: hash,
            leaseUntil: claim.leaseUntil,
          };
        }

        const context: RouteHandlerContext<Schemas> = {
          request,
          auth,
          input,
          requestId,
          correlationId: requestId,
          clientRequestId,
          now,
          host: new URL(request.url).host.toLowerCase(),
        };
        const handlerOutput = await definition.handler(context);
        const output =
          successStatus === 204 || process.env.NODE_ENV !== 'production'
            ? definition.output.parse(handlerOutput)
            : handlerOutput;
        if (successStatus === 204 && output !== undefined) {
          throw new Error('A 204 route handler must return undefined.');
        }
        const responseBodyByteLength = successStatus === 204 ? 0 : encodeBody(output).byteLength;

        if (idempotencyLease) {
          if (responseBodyByteLength > MAX_REPLAY_BODY_BYTES) {
            await releaseIdempotency(dependencies, {
              ...idempotencyLease,
              operationId: definition.operationId,
            });
            idempotencyLease = undefined;
          } else {
            try {
              await dependencies.idempotencyStore.complete({
                ...idempotencyLease,
                response: {
                  status: successStatus,
                  body: successStatus === 204 ? null : output,
                },
              });
              idempotencyLease = undefined;
            } catch (error) {
              dependencies.logger.error('Idempotency response storage failed', {
                route: definition.operationId,
                ...safeErrorFields(error),
              });
              throw new HttpProblem(
                503,
                'idempotency.unavailable',
                'Request could not be processed.',
              );
            }
          }
        }

        outcome = 'success';
        return createResponse(
          output,
          successStatus,
          requestId,
          responseHeaders,
          definition.cachePolicy === 'public-app-config'
            ? PUBLIC_APP_CONFIG_CACHE_CONTROL
            : undefined,
        );
      } catch (error) {
        if (idempotencyLease) {
          await releaseIdempotency(dependencies, {
            ...idempotencyLease,
            operationId: definition.operationId,
          });
        }
        if (error instanceof HttpProblem) {
          outcome = error.status >= 500 ? 'error' : 'rejected';
          const headers = new Headers(responseHeaders);
          new Headers(error.responseHeaders).forEach((value, key) => headers.set(key, value));
          return applySecurityHeaders(
            problemResponse(error.status, error.code, error.title, requestId, headers),
          );
        }

        dependencies.logger.error('Unhandled API route error', {
          route: definition.operationId,
          requestId,
          clientRequestId,
          ...safeErrorFields(error),
        });
        outcome = 'error';
        return applySecurityHeaders(
          problemResponse(500, 'internal.error', 'An unexpected error occurred.', requestId),
        );
      } finally {
        if (definition.operationId !== 'getHealth') {
          metric('api.request.outcome', 1, { operation_id: definition.operationId, outcome });
          metric('api.request.duration_ms', performance.now() - startedAt, {
            operation_id: definition.operationId,
          });
          try {
            dependencies.logger.info('API request completed', {
              route: definition.operationId,
              requestId,
              clientRequestId,
              outcome,
              ...(authenticatedUserId === undefined ? {} : { userId: authenticatedUserId }),
            });
          } catch {
            // Completion logging must not affect the HTTP response.
          }
        }
      }
    };
  };
}

const defaultRouteDependencies = createDefaultRouteDependencies();

export const defineRoute = createDefineRoute(defaultRouteDependencies);
