import { randomBytes } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';

import { parseServerEnv } from './platform/env/index';
import { edgeExtensions } from './extensions/edge';
import { createLogger } from './platform/observability/logger';
import { applySecurityHeaders } from './platform/http/security-headers';
import { problemResponse } from './platform/http/problem';
import { createUuidV7 } from './platform/http/request-id';
import { buildContentSecurityPolicy, hardeningHeadersForPath } from './platform/edge/csp';
import { resolveEdgeRequest, type EdgeEnvironment } from './platform/edge/host-policy';
import type { EdgeExtension } from './platform/extensions/types';

const logger = createLogger();

export function applyProxyResponseHeaders(
  response: Response,
  input: {
    readonly method: string;
    readonly path: string;
    readonly extensions: readonly EdgeExtension[];
  },
): Response {
  const routeOwnsPublicCache =
    input.method === 'GET' && input.path === '/api/v1/app-config' && response.status === 200;
  if (!routeOwnsPublicCache) response.headers.set('Cache-Control', 'no-store');
  for (const [name, value] of Object.entries(hardeningHeadersForPath(input.path, input.extensions))) {
    response.headers.set(name, value);
  }
  return response;
}

function notFoundResponse(): Response {
  const requestId = createUuidV7();
  return applySecurityHeaders(problemResponse(404, 'edge.not_found', 'Not found.', requestId));
}

function unavailableResponse(error: unknown): Response {
  logger.error('Edge configuration failed', {
    errorName:
      typeof error === 'object' &&
      error !== null &&
      'name' in error &&
      typeof error.name === 'string'
        ? error.name
        : 'Error',
    errorCode:
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : 'edge.configuration',
  });
  const requestId = createUuidV7();
  return applySecurityHeaders(
    problemResponse(
      503,
      'edge.configuration_unavailable',
      'Request could not be processed.',
      requestId,
    ),
  );
}

export function proxy(request: NextRequest): Response {
  try {
    const environment = parseServerEnv() as EdgeEnvironment;
    const decision = resolveEdgeRequest({
      requestHost: request.headers.get('host'),
      requestPath: request.nextUrl.pathname,
      environment,
      extensions: edgeExtensions,
    });
    if (!decision.allowed) return notFoundResponse();

    const nonce = randomBytes(18).toString('base64');
    const requestHeaders = new Headers(request.headers);
    const contentSecurityPolicy = buildContentSecurityPolicy(nonce, decision.path, edgeExtensions);
    requestHeaders.set('Content-Security-Policy', contentSecurityPolicy);
    requestHeaders.set('x-csp-nonce', nonce);

    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set('Content-Security-Policy', contentSecurityPolicy);
    return applyProxyResponseHeaders(response, {
      method: request.method,
      path: decision.path,
      extensions: edgeExtensions,
    });
  } catch (error) {
    return unavailableResponse(error);
  }
}

export const config = {
  matcher: ['/:path*'],
};
