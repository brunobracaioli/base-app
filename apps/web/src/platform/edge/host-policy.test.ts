import { describe, expect, it } from 'vitest';

import { resolveEdgeRequest } from './host-policy';
import type { EdgeExtension } from '../extensions/types';

const extensions: readonly EdgeExtension[] = [
  {
    name: 'panel',
    hosts: [{ hostEnv: 'PANEL_HOST', pathPrefixes: ['/panel'] }],
  },
];

const environment = {
  APP_HOST: 'app.example',
  VERCEL_ENV: 'preview',
  VERCEL_URL: 'preview.example',
  VERCEL_BRANCH_URL: 'branch.example',
  PANEL_HOST: 'panel.example',
};

describe('edge host and path policy', () => {
  it('allows only the app and configured preview hosts', () => {
    expect(
      resolveEdgeRequest({ requestHost: 'app.example', requestPath: '/', environment, extensions }),
    ).toMatchObject({
      allowed: true,
      hostKind: 'app',
    });
    expect(
      resolveEdgeRequest({
        requestHost: 'preview.example',
        requestPath: '/',
        environment,
        extensions,
      }),
    ).toMatchObject({
      allowed: true,
      hostKind: 'app',
    });
    expect(
      resolveEdgeRequest({
        requestHost: 'branch.example',
        requestPath: '/',
        environment,
        extensions,
      }),
    ).toMatchObject({
      allowed: true,
      hostKind: 'app',
    });
    expect(
      resolveEdgeRequest({
        requestHost: 'unknown.example',
        requestPath: '/',
        environment,
        extensions,
      }),
    ).toEqual({
      allowed: false,
    });
  });

  it('serves extension paths only on the configured extension host', () => {
    expect(
      resolveEdgeRequest({
        requestHost: 'panel.example',
        requestPath: '/panel/users',
        environment,
        extensions,
      }),
    ).toMatchObject({ allowed: true, hostKind: 'extension', extensionName: 'panel' });
    expect(
      resolveEdgeRequest({
        requestHost: 'panel.example',
        requestPath: '/',
        environment,
        extensions,
      }),
    ).toEqual({
      allowed: false,
    });
    expect(
      resolveEdgeRequest({
        requestHost: 'app.example',
        requestPath: '/panel/users',
        environment,
        extensions,
      }),
    ).toEqual({
      allowed: false,
    });
  });

  it('rejects ambiguous, invalid and normalized bypass paths before prefix comparison', () => {
    for (const requestPath of [
      '//panel',
      '/a/../panel',
      '/%2e%2e/panel',
      '/panel%2f',
      '/panel%5c',
      '/panel\\users',
    ]) {
      expect(
        resolveEdgeRequest({ requestHost: 'app.example', requestPath, environment, extensions }),
      ).toEqual({
        allowed: false,
      });
    }
  });

  it('does not accept preview host variables outside preview', () => {
    expect(
      resolveEdgeRequest({
        requestHost: 'preview.example',
        requestPath: '/',
        environment: { ...environment, VERCEL_ENV: 'production' },
        extensions,
      }),
    ).toEqual({ allowed: false });
  });

  it('fails closed for an extension host collision', () => {
    const duplicateHosts: readonly EdgeExtension[] = [
      ...extensions,
      { name: 'other-panel', hosts: [{ hostEnv: 'PANEL_HOST', pathPrefixes: ['/other'] }] },
    ];
    expect(() =>
      resolveEdgeRequest({
        requestHost: 'panel.example',
        requestPath: '/panel',
        environment,
        extensions: duplicateHosts,
      }),
    ).toThrow();
  });
});
