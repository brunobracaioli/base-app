import { describe, expect, it } from 'vitest';

import { applySecurityHeaders } from './security-headers';

describe('independent response security headers', () => {
  it('adds static security headers even without the Proxy layer', () => {
    const response = applySecurityHeaders(new Response('ok'));
    expect(response.headers.get('strict-transport-security')).toContain('max-age=63072000');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
