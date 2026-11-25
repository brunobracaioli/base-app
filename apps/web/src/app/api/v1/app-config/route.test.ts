import { afterEach, describe, expect, it, vi } from 'vitest';
import productConfig from '@base-app/config/product.config';

import { GET as getHealth } from '../health/route';
import { GET } from './route';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /v1/app-config route adapter', () => {
  it('returns a public safe config with identical output across query variants when DB and Redis config are absent', async () => {
    vi.stubEnv('APP_HOST', 'app.example.invalid');
    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('DATABASE_CA_CERT', '');
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');

    const first = await GET(
      new Request('https://app.example.invalid/api/v1/app-config?variant=ios', {
        headers: { 'x-real-ip': '198.51.100.12' },
      }),
    );
    const second = await GET(
      new Request('https://app.example.invalid/api/v1/app-config?variant=android', {
        headers: { 'x-real-ip': '198.51.100.12' },
      }),
    );

    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe(
      'public, s-maxage=60, stale-while-revalidate=60',
    );
    expect(first.headers.get('x-rate-limit-failure')).toBe('open');
    const body = await first.json();
    expect(body).toEqual(await second.json());
    expect(body).toMatchObject({
      versions: {
        ios: { minSupported: '0.0.0', latest: '0.0.0' },
        android: { minSupported: '0.0.0', latest: '0.0.0' },
      },
      maintenance: { active: false, platforms: ['ios', 'android'] },
      legal: { termsVersion: '2026-01-01', privacyVersion: '2026-01-01' },
    });
    expect(body.versions.ios.storeUrl).toBe(
      `https://apps.apple.com/app/id${productConfig.ios.appStoreId}`,
    );
    expect(body.versions.android.storeUrl).toBe(
      `https://play.google.com/store/apps/details?id=${encodeURIComponent(productConfig.android.package)}`,
    );
    expect(body.legal.termsUrl).toBe(
      new URL(productConfig.legal.termsPath, productConfig.web.origin).toString(),
    );
    expect(body.legal.privacyUrl).toBe(
      new URL(productConfig.legal.privacyPath, productConfig.web.origin).toString(),
    );
    expect(JSON.stringify(body)).not.toMatch(/userId|email|token/i);
  });

  it('keeps health available without database configuration', async () => {
    vi.stubEnv('APP_HOST', 'app.example.invalid');
    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('DATABASE_CA_CERT', '');
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');

    const response = await getHealth(
      new Request('https://app.example.invalid/api/v1/health', {
        headers: { 'x-real-ip': '198.51.100.12' },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
