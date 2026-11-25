import { describe, expect, it } from 'vitest';

import { parseServerEnv, validateRuntimeEnvironment } from './index';

const baseEnvironment = { APP_HOST: 'localhost:3000' };

describe('server environment validation', () => {
  it('requires an explicit app host', () => {
    expect(() => parseServerEnv({})).toThrow();
    expect(parseServerEnv(baseEnvironment).APP_HOST).toBe('localhost:3000');
  });

  it('accepts a trusted Supabase HTTPS origin and limits HTTP to loopback development/test', () => {
    expect(
      parseServerEnv({ ...baseEnvironment, SUPABASE_URL: 'https://project.supabase.co' })
        .SUPABASE_URL,
    ).toBe('https://project.supabase.co');
    expect(
      parseServerEnv({
        ...baseEnvironment,
        NODE_ENV: 'test',
        SUPABASE_URL: 'http://127.0.0.1:54421',
      }).SUPABASE_URL,
    ).toBe('http://127.0.0.1:54421');
    expect(() =>
      parseServerEnv({
        ...baseEnvironment,
        NODE_ENV: 'test',
        SUPABASE_URL: 'http://supabase.example',
      }),
    ).toThrow();
    expect(() =>
      parseServerEnv({
        ...baseEnvironment,
        NODE_ENV: 'production',
        SUPABASE_URL: 'http://127.0.0.1:54421',
      }),
    ).toThrow(/development or test/);
  });

  it('rejects Supabase URLs containing credentials, paths, queries, or fragments', () => {
    for (const SUPABASE_URL of [
      'https://user:secret@project.supabase.co',
      'https://project.supabase.co/auth/v1',
      'https://project.supabase.co?token=secret',
      'https://project.supabase.co/#fragment',
    ]) {
      expect(() => parseServerEnv({ ...baseEnvironment, SUPABASE_URL })).toThrow();
    }
  });

  it('requires Redis REST URLs to use HTTPS without embedded credentials or query strings', () => {
    expect(() =>
      parseServerEnv({
        ...baseEnvironment,
        UPSTASH_REDIS_REST_URL: 'http://redis.example',
        UPSTASH_REDIS_REST_TOKEN: 'generated-test-only-token',
      }),
    ).toThrow();
    expect(() =>
      parseServerEnv({
        ...baseEnvironment,
        UPSTASH_REDIS_REST_URL: 'https://user:generated-test-only-token@redis.example',
        UPSTASH_REDIS_REST_TOKEN: 'generated-test-only-token',
      }),
    ).toThrow();
    expect(() =>
      parseServerEnv({
        ...baseEnvironment,
        UPSTASH_REDIS_REST_URL: 'https://redis.example/?token=generated-test-only-token',
        UPSTASH_REDIS_REST_TOKEN: 'generated-test-only-token',
      }),
    ).toThrow();
    expect(
      parseServerEnv({
        ...baseEnvironment,
        UPSTASH_REDIS_REST_URL: 'https://redis.example',
        UPSTASH_REDIS_REST_TOKEN: 'generated-test-only-token',
      }).UPSTASH_REDIS_REST_URL,
    ).toBe('https://redis.example');
  });

  it('rejects partial Upstash configuration', () => {
    expect(() =>
      parseServerEnv({ ...baseEnvironment, UPSTASH_REDIS_REST_URL: 'https://redis.example' }),
    ).toThrow();
  });

  it('validates PostgreSQL URL protocol, forbids SSL query overrides, and requires a CA certificate', () => {
    for (const sslParameter of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'ssl']) {
      expect(() =>
        parseServerEnv({
          ...baseEnvironment,
          DATABASE_URL: `postgres://db.example:6543/app?${sslParameter.toUpperCase()}=disable`,
          DATABASE_CA_CERT: 'test-only-certificate',
        }),
      ).toThrow(/must not override TLS/);
    }
    expect(() =>
      parseServerEnv({
        ...baseEnvironment,
        DATABASE_URL: 'https://db.example/app',
        DATABASE_CA_CERT: 'test-only-certificate',
      }),
    ).toThrow();
    expect(() =>
      parseServerEnv({
        ...baseEnvironment,
        DATABASE_URL: 'postgresql://db.example:6543/app',
      }),
    ).toThrow(/configured together/);
    expect(
      parseServerEnv({
        ...baseEnvironment,
        DATABASE_URL: 'postgresql://db.example:6543/app',
        DATABASE_CA_CERT: 'test-only-certificate',
      }).DATABASE_URL,
    ).toBe('postgresql://db.example:6543/app');
  });

  it('permits an intentionally local foundation but rejects missing active Redis config in Vercel', () => {
    expect(
      validateRuntimeEnvironment({ ...baseEnvironment, VERCEL_ENV: 'development' }).APP_HOST,
    ).toBe('localhost:3000');
    expect(() => validateRuntimeEnvironment({ ...baseEnvironment, VERCEL_ENV: 'preview' })).toThrow(
      /required for Vercel preview and production/,
    );
    expect(() =>
      validateRuntimeEnvironment({ ...baseEnvironment, VERCEL_ENV: 'production' }),
    ).toThrow(/required for Vercel preview and production/);
    expect(() =>
      validateRuntimeEnvironment({
        ...baseEnvironment,
        VERCEL_ENV: 'preview',
        UPSTASH_REDIS_REST_URL: 'https://redis.example',
        UPSTASH_REDIS_REST_TOKEN: 'generated-test-only-token',
      }),
    ).toThrow(/Database URL and TLS CA certificate/);
    expect(
      validateRuntimeEnvironment({
        ...baseEnvironment,
        VERCEL_ENV: 'preview',
        UPSTASH_REDIS_REST_URL: 'https://redis.example',
        UPSTASH_REDIS_REST_TOKEN: 'generated-test-only-token',
        DATABASE_URL: 'postgresql://db.example:6543/app',
        DATABASE_CA_CERT: 'test-only-certificate',
        SUPABASE_URL: 'https://project.supabase.co',
      }).VERCEL_ENV,
    ).toBe('preview');
    expect(() =>
      validateRuntimeEnvironment({
        ...baseEnvironment,
        VERCEL_ENV: 'preview',
        UPSTASH_REDIS_REST_URL: 'https://redis.example',
        UPSTASH_REDIS_REST_TOKEN: 'generated-test-only-token',
        DATABASE_URL: 'postgresql://db.example:6543/app',
        DATABASE_CA_CERT: 'test-only-certificate',
      }),
    ).toThrow(/SUPABASE_URL is required/);
  });
});
