import { describe, expect, it } from 'vitest';

import { ipAddress, normalizeIpAddress } from './ip-address';

describe('Vercel client IP handling', () => {
  it('uses the Vercel SDK header source before applying IPv6 /64 bucketing', () => {
    const request = new Request('https://app.example/', {
      headers: {
        'x-real-ip': '2001:db8::1234',
        'x-forwarded-for': '198.51.100.20, 203.0.113.15',
      },
    });
    expect(ipAddress(request)).toBe('2001:0db8:0000:0000/64');
  });

  it('canonicalizes IPv4 and IPv4-mapped IPv6 values', () => {
    expect(normalizeIpAddress('192.0.2.10')).toBe('192.0.2.10');
    expect(normalizeIpAddress('::ffff:192.0.2.10')).toBe('192.0.2.10');
  });

  it('uses a shared unknown bucket for invalid or absent trusted IP headers', () => {
    expect(ipAddress(new Request('https://app.example/'))).toBe('unknown');
    expect(
      ipAddress(
        new Request('https://app.example/', {
          headers: { 'x-real-ip': 'not-an-ip', 'x-forwarded-for': '203.0.113.15' },
        }),
      ),
    ).toBe('unknown');
  });
});
