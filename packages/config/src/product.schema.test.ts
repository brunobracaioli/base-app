import { ZodError } from 'zod';
import { describe, expect, it } from 'vitest';

import product from './product.config.js';
import { extensionAuthMethods, extensionConfigSchema } from './extensions.js';
import { defineProduct, productConfigSchema } from './product.schema.js';

function expectInvalidProduct(input: unknown): void {
  expect(() => productConfigSchema.parse(input)).toThrow(ZodError);
}

describe('product configuration', () => {
  it('accepts the non-operational template example and applies documented defaults', () => {
    const parsed = defineProduct(product);
    const withDefaults = productConfigSchema.parse({
      ...product,
      auth: { methods: product.auth.methods },
      billing: { entitlements: product.billing.entitlements },
    });

    expect(parsed.slug).toBe('myapp');
    expect(parsed.extensions).toEqual({});
    expect(withDefaults.auth.recentAuthMaxAgeSec).toBe(300);
    expect(withDefaults.billing.cacheTtlSec).toBe(60);
  });

  it('throws ZodError for an invalid product configuration', () => {
    const result = productConfigSchema.safeParse({ ...product, slug: 'My App' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(ZodError);
      expect(result.error.issues.some((issue) => issue.path[0] === 'slug')).toBe(true);
    }
  });

  it('enforces the documented recent-auth, billing, entitlement, and quota limits', () => {
    expectInvalidProduct({ ...product, auth: { ...product.auth, recentAuthMaxAgeSec: 59 } });
    expectInvalidProduct({ ...product, auth: { ...product.auth, recentAuthMaxAgeSec: 901 } });
    expectInvalidProduct({ ...product, billing: { ...product.billing, cacheTtlSec: 14 } });
    expectInvalidProduct({ ...product, billing: { ...product.billing, cacheTtlSec: 301 } });
    expectInvalidProduct({
      ...product,
      billing: {
        ...product.billing,
        entitlements: Array.from({ length: 11 }, (_, index) => `plan-${index}`),
      },
    });
    expectInvalidProduct({ ...product, quotas: { action: { perDay: { pro: 1_000_001 } } } });
    expectInvalidProduct({
      ...product,
      quotas: { action: { perDay: { pro: 1 }, globalPerDay: 1_000_001 } },
    });
    expectInvalidProduct({
      ...product,
      quotas: Object.fromEntries(
        Array.from({ length: 21 }, (_, index) => [
          `action-${index}`,
          { perDay: { pro: 1 }, globalPerDay: 1 },
        ]),
      ),
    });
  });

  it('requires both quota dimensions and at least one entitlement limit', () => {
    expectInvalidProduct({ ...product, quotas: { action: { perDay: { pro: 1 } } } });
    expectInvalidProduct({ ...product, quotas: { action: { globalPerDay: 1 } } });
    expectInvalidProduct({ ...product, quotas: { action: { perDay: {}, globalPerDay: 1 } } });
  });

  it('rejects unknown auth methods, duplicate locales, and quota entitlements not in billing', () => {
    expectInvalidProduct({
      ...product,
      auth: { ...product.auth, methods: ['email_otp', 'magic_link'] },
    });
    expectInvalidProduct({ ...product, locales: ['en', 'en'] });
    expectInvalidProduct({ ...product, quotas: { action: { perDay: { other: 5 } } } });
  });

  it('keeps extension configuration and extension auth methods empty in the base app', () => {
    expect(extensionAuthMethods).toEqual([]);
    expect(extensionConfigSchema.parse({})).toEqual({});
    expect(() => extensionConfigSchema.parse({ feature: true })).toThrow(ZodError);
    expectInvalidProduct({ ...product, extensions: { feature: true } });
  });

  it('requires secure origins and safe legal paths', () => {
    expectInvalidProduct({ ...product, web: { origin: 'http://myapp.example.invalid' } });
    expectInvalidProduct({ ...product, web: { origin: 'https://myapp.example.invalid/path' } });
    expectInvalidProduct({ ...product, legal: { ...product.legal, termsPath: '/../terms' } });
    expectInvalidProduct({ ...product, android: { package: 'com.example.invalid-package' } });
  });
});
