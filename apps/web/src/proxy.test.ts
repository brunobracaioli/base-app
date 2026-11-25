import { describe, expect, it } from 'vitest';

import type { EdgeExtension } from './platform/extensions/types';
import { applyProxyResponseHeaders } from './proxy';

const PUBLIC_CONFIG_CACHE = 'public, s-maxage=60, stale-while-revalidate=60';

describe('proxy response cache hardening', () => {
  it('defers cache policy only for the exact successful app-config GET', () => {
    const response = new Response('{}', {
      status: 200,
      headers: { 'Cache-Control': PUBLIC_CONFIG_CACHE },
    });

    applyProxyResponseHeaders(response, {
      method: 'GET',
      path: '/api/v1/app-config',
      extensions: [],
    });

    expect(response.headers.get('cache-control')).toBe(PUBLIC_CONFIG_CACHE);
  });

  it.each([
    { method: 'POST', path: '/api/v1/app-config', status: 200 },
    { method: 'GET', path: '/api/v1/app-config/', status: 200 },
    { method: 'GET', path: '/api/v1/me', status: 200 },
    { method: 'GET', path: '/api/v1/app-config', status: 503 },
  ])('keeps no-store for non-success, private, or non-exact responses: $method $path $status', (input) => {
    const response = new Response('{}', {
      status: input.status,
      headers: { 'Cache-Control': PUBLIC_CONFIG_CACHE },
    });

    applyProxyResponseHeaders(response, { ...input, extensions: [] });

    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('keeps an extension no-store override authoritative on the public app-config path', () => {
    const extensions: readonly EdgeExtension[] = [
      {
        name: 'private-path',
        headers: [
          {
            pathPrefix: '/api/v1',
            set: { 'Cache-Control': 'no-store' },
          },
        ],
      },
    ];
    const response = new Response('{}', {
      status: 200,
      headers: { 'Cache-Control': PUBLIC_CONFIG_CACHE },
    });

    applyProxyResponseHeaders(response, {
      method: 'GET',
      path: '/api/v1/app-config',
      extensions,
    });

    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
