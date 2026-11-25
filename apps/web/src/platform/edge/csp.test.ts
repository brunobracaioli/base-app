import { describe, expect, it } from 'vitest';

import {
  buildContentSecurityPolicy,
  hardeningHeadersForPath,
  validateEdgeCsp,
  validateEdgeHeaders,
} from './csp';
import type { EdgeExtension } from '../extensions/types';

describe('edge CSP and hardening headers', () => {
  it('builds a nonce CSP and applies extension sources only within the prefix', () => {
    const extensions: readonly EdgeExtension[] = [
      {
        name: 'captcha',
        csp: [
          {
            pathPrefix: '/account-deletion',
            directives: { 'script-src': ['https://captcha.example'] },
          },
        ],
      },
    ];
    const applied = buildContentSecurityPolicy('nonce-value', '/account-deletion', extensions);
    const notApplied = buildContentSecurityPolicy('nonce-value', '/', extensions);
    expect(applied).toContain("'nonce-nonce-value'");
    expect(applied).toContain('https://captcha.example');
    expect(notApplied).not.toContain('https://captcha.example');
  });

  it('preserves every strict D18 directive and trusted-types policy', () => {
    const extensions: readonly EdgeExtension[] = [
      {
        name: 'delete-page',
        csp: [
          {
            pathPrefix: '/account-deletion',
            strict: { trustedTypesPolicies: ['account-delete'] },
            directives: { 'connect-src': ['https://captcha.example'] },
          },
        ],
      },
    ];
    const csp = buildContentSecurityPolicy('nonce-value', '/account-deletion', extensions);
    for (const directive of [
      "default-src 'none'",
      "script-src 'self' 'nonce-nonce-value' 'strict-dynamic'",
      "style-src 'self' 'nonce-nonce-value'",
      "img-src 'self'",
      "font-src 'self'",
      "connect-src 'self' https://captcha.example",
      "object-src 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "require-trusted-types-for 'script'",
      'trusted-types account-delete',
    ]) {
      expect(csp).toContain(directive);
    }
  });

  it('rejects sources that could loosen CSP and broad prefixes on the session page', () => {
    for (const source of [
      '*',
      'http://captcha.example',
      'data:',
      'blob:',
      "'unsafe-inline'",
      "'unsafe-eval'",
    ]) {
      const extension: EdgeExtension = {
        name: 'invalid-csp',
        csp: [{ pathPrefix: '/preview', directives: { 'script-src': [source] } }],
      };
      expect(() => validateEdgeCsp([extension])).toThrow();
    }
    expect(() =>
      validateEdgeCsp([
        {
          name: 'broad',
          csp: [{ pathPrefix: '/', directives: { 'script-src': ['https://captcha.example'] } }],
        },
      ]),
    ).toThrow();
    expect(() =>
      validateEdgeCsp([
        {
          name: 'session',
          csp: [
            {
              pathPrefix: '/account-deletion',
              directives: { 'style-src': ['https://captcha.example'] },
            },
          ],
        },
      ]),
    ).toThrow();
    expect(() =>
      validateEdgeCsp([
        {
          name: 'session',
          csp: [
            {
              pathPrefix: '/account-deletion',
              directives: {
                'connect-src': ['https://a.example', 'https://b.example', 'https://c.example'],
              },
            },
          ],
        },
      ]),
    ).toThrow();
  });

  it('rejects invalid trusted-types policy names', () => {
    expect(() =>
      validateEdgeCsp([
        {
          name: 'invalid-types',
          csp: [{ pathPrefix: '/page', directives: {}, strict: { trustedTypesPolicies: ['*'] } }],
        },
      ]),
    ).toThrow();
  });

  it('accepts only hardening headers and exact allowed values', () => {
    const allowed: readonly EdgeExtension[] = [
      {
        name: 'privacy',
        headers: [
          {
            pathPrefix: '/account-deletion',
            set: { 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' },
          },
        ],
      },
    ];
    validateEdgeHeaders(allowed);
    expect(hardeningHeadersForPath('/account-deletion/cancel', allowed)).toEqual({
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    });
    expect(hardeningHeadersForPath('/account', allowed)).toEqual({});
    expect(() =>
      validateEdgeHeaders([
        { name: 'weak', headers: [{ pathPrefix: '/page', set: { 'Referrer-Policy': 'origin' } }] },
      ]),
    ).toThrow();
    expect(() =>
      validateEdgeHeaders([
        {
          name: 'unknown',
          headers: [{ pathPrefix: '/page', set: { 'X-Frame-Options': 'ALLOWALL' } as never }],
        },
      ]),
    ).toThrow();
  });
});
