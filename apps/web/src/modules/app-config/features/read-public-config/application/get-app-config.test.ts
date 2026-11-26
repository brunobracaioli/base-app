import { describe, expect, it } from 'vitest';

import type {
  AppConfigSettings,
  AppConfigSettingsReadResult,
  AppConfigSettingsReader,
} from '../../../domain/settings';
import { createAppConfigQuery, APP_CONFIG_CACHE_TTL_MS } from './get-app-config';

const PRODUCT_URLS = {
  iosStoreUrl: 'https://apps.apple.com/app/id0000000000',
  androidStoreUrl: 'https://play.google.com/store/apps/details?id=com.example.myapp',
  termsUrl: 'https://myapp.example.invalid/terms',
  privacyUrl: 'https://myapp.example.invalid/privacy',
} as const;

const VALID_SETTINGS: AppConfigSettings = {
  versions: {
    ios: { minSupported: '1.2.0', latest: '1.10.0', published: '1.11.0' },
    android: { minSupported: '2.0.0', latest: '2.4.0' },
  },
  maintenance: {
    active: false,
    platforms: ['ios', 'android'],
    messageKey: 'maintenance.default',
    until: null,
  },
  legal: { termsVersion: '2026-02-03', privacyVersion: '2026-02-04' },
};

function createReader(read: () => Promise<AppConfigSettingsReadResult>) {
  return { readAll: read } satisfies AppConfigSettingsReader;
}

function createQuery(input: {
  readonly reader: AppConfigSettingsReader;
  readonly now?: () => Date;
  readonly observer?: Parameters<typeof createAppConfigQuery>[0]['observer'];
  readonly ttlMs?: number;
}) {
  return createAppConfigQuery({
    reader: input.reader,
    productUrls: PRODUCT_URLS,
    clock: { now: input.now ?? (() => new Date('2026-11-25T12:00:00.000Z')) },
    ...(input.observer === undefined ? {} : { observer: input.observer }),
    ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
  });
}

function completeRead(settings: AppConfigSettings): AppConfigSettingsReadResult {
  return { settings, invalidKeys: [] };
}

describe('get public app config application query', () => {
  it('normalizes settings and builds all public URLs from the injected product values', async () => {
    const query = createQuery({ reader: createReader(async () => completeRead(VALID_SETTINGS)) });

    await expect(query.getPublicConfig()).resolves.toEqual({
      versions: {
        ios: {
          minSupported: '1.2.0',
          latest: '1.10.0',
          storeUrl: PRODUCT_URLS.iosStoreUrl,
        },
        android: {
          minSupported: '2.0.0',
          latest: '2.4.0',
          storeUrl: PRODUCT_URLS.androidStoreUrl,
        },
      },
      maintenance: {
        active: false,
        platforms: ['ios', 'android'],
        messageKey: 'maintenance.default',
        until: null,
      },
      legal: {
        termsVersion: '2026-02-03',
        privacyVersion: '2026-02-04',
        termsUrl: PRODUCT_URLS.termsUrl,
        privacyUrl: PRODUCT_URLS.privacyUrl,
      },
    });
  });

  it('uses safe defaults for missing values and reports the three missing keys', async () => {
    const invalidKeys: string[] = [];
    const query = createQuery({
      reader: createReader(async () => ({ settings: {}, invalidKeys: [] })),
      observer: { invalidSetting: (key) => invalidKeys.push(key), readFailed() {} },
    });

    const config = await query.getPublicConfig();
    expect(config.versions.ios).toMatchObject({ minSupported: '0.0.0', latest: '0.0.0' });
    expect(config.versions.android).toMatchObject({ minSupported: '0.0.0', latest: '0.0.0' });
    expect(config.maintenance).toMatchObject({ active: false, platforms: ['ios', 'android'] });
    expect(config.legal).toMatchObject({
      termsVersion: '2026-01-01',
      privacyVersion: '2026-01-01',
    });
    expect(invalidKeys).toEqual(['versions', 'maintenance', 'legal']);
  });

  it('retains last valid values independently when a later refresh invalidates one key', async () => {
    let next = completeRead(VALID_SETTINGS);
    let nowMs = 0;
    const invalidKeys: string[] = [];
    const query = createQuery({
      reader: createReader(async () => next),
      now: () => new Date(nowMs),
      observer: { invalidSetting: (key) => invalidKeys.push(key), readFailed() {} },
    });
    await query.getPublicConfig();

    next = {
      settings: {
        versions: {
          ios: { minSupported: '1.3.0', latest: '1.12.0' },
          android: { minSupported: '2.0.0', latest: '2.5.0' },
        },
        legal: { termsVersion: '2026-03-03', privacyVersion: '2026-03-04' },
      },
      invalidKeys: ['maintenance'],
    };
    nowMs = APP_CONFIG_CACHE_TTL_MS;

    const config = await query.getPublicConfig();
    expect(config.versions.ios.minSupported).toBe('1.3.0');
    expect(config.maintenance).toMatchObject({ active: false, platforms: ['ios', 'android'] });
    expect(config.legal.termsVersion).toBe('2026-03-03');
    expect(invalidKeys).toEqual(['maintenance']);
  });

  it('uses last known settings on a failed database read and reports the read failure safely', async () => {
    let fail = false;
    const failed: unknown[] = [];
    const query = createQuery({
      reader: createReader(async () => {
        if (fail) throw new Error('secret-bearing database diagnostic');
        return completeRead(VALID_SETTINGS);
      }),
      now: (() => {
        let time = 0;
        return () => new Date(time++ * APP_CONFIG_CACHE_TTL_MS);
      })(),
      observer: { invalidSetting() {}, readFailed: (error) => failed.push(error) },
    });
    await query.getPublicConfig();
    fail = true;

    await expect(query.getPublicConfig()).resolves.toMatchObject({
      versions: { ios: { minSupported: '1.2.0' } },
      legal: { termsVersion: '2026-02-03' },
    });
    expect(failed).toHaveLength(1);
    expect(failed[0]).toBeInstanceOf(Error);
  });

  it('refreshes after 30 seconds and shares one in-flight refresh across concurrent readers', async () => {
    let nowMs = 0;
    let readCount = 0;
    let releaseRead: ((result: AppConfigSettingsReadResult) => void) | undefined;
    const reader = createReader(
      () =>
        new Promise((resolve) => {
          readCount += 1;
          releaseRead = resolve;
        }),
    );
    const query = createQuery({ reader, now: () => new Date(nowMs) });

    const first = query.getPublicConfig();
    const second = query.getPublicConfig();
    const third = query.getPublicConfig();
    expect(readCount).toBe(1);
    releaseRead?.(completeRead(VALID_SETTINGS));
    const [firstResult, secondResult, thirdResult] = await Promise.all([first, second, third]);
    expect(firstResult).not.toBe(secondResult);
    expect(secondResult).not.toBe(thirdResult);

    nowMs = APP_CONFIG_CACHE_TTL_MS - 1;
    await query.getPublicConfig();
    expect(readCount).toBe(1);
    nowMs = APP_CONFIG_CACHE_TTL_MS;
    const refresh = query.getPublicConfig();
    expect(readCount).toBe(2);
    releaseRead?.(completeRead(VALID_SETTINGS));
    await refresh;
  });

  it('does not expose mutable cache objects through returned responses', async () => {
    const query = createQuery({ reader: createReader(async () => completeRead(VALID_SETTINGS)) });
    const first = await query.getPublicConfig();
    (first.maintenance.platforms as string[]).splice(0, 1);
    (first.versions.ios as { minSupported: string }).minSupported = '999.0.0';

    const second = await query.getPublicConfig();
    expect(second.maintenance.platforms).toEqual(['ios', 'android']);
    expect(second.versions.ios.minSupported).toBe('1.2.0');
  });

  it('evaluates update before maintenance, applies global maintenance without a platform, and keeps exempt maintenance from bypassing updates', async () => {
    const query = createQuery({
      reader: createReader(async () =>
        completeRead({
          ...VALID_SETTINGS,
          versions: {
            ios: { minSupported: '1.10.0', latest: '1.10.0' },
            android: { minSupported: '1.0.0', latest: '2.0.0' },
          },
          maintenance: {
            active: true,
            platforms: ['ios', 'android'],
            messageKey: 'maintenance.default',
            until: null,
          },
        }),
      ),
    });

    await expect(
      query.checkGate({ appVersion: '1.9.0', platform: 'ios', maintenance: 'block' }),
    ).resolves.toMatchObject({ status: 426, code: 'app.update_required' });
    await expect(
      query.checkGate({ appVersion: null, platform: null, maintenance: 'block' }),
    ).resolves.toMatchObject({ status: 503, code: 'app.maintenance', retryAfterSec: 60 });
    await expect(
      query.checkGate({ appVersion: '1.10.0', platform: 'ios', maintenance: 'exempt' }),
    ).resolves.toEqual({ allow: true });
  });

  it('ignores missing or invalid version headers and limits platform maintenance to matching platforms', async () => {
    const query = createQuery({
      reader: createReader(async () =>
        completeRead({
          ...VALID_SETTINGS,
          maintenance: {
            active: true,
            platforms: ['ios'],
            messageKey: 'maintenance.ios_only',
            until: null,
          },
        }),
      ),
    });

    await expect(
      query.checkGate({ appVersion: null, platform: 'ios', maintenance: 'block' }),
    ).resolves.toMatchObject({ status: 503 });
    await expect(
      query.checkGate({ appVersion: '1.2', platform: 'ios', maintenance: 'block' }),
    ).resolves.toMatchObject({ status: 503 });
    await expect(
      query.checkGate({ appVersion: '2.0.0', platform: 'android', maintenance: 'block' }),
    ).resolves.toEqual({ allow: true });
    await expect(
      query.checkGate({ appVersion: '1.10.0', platform: 'unsupported', maintenance: 'block' }),
    ).resolves.toEqual({ allow: true });
  });

  it('rejects an unsafe cache TTL and allows an exact single millisecond TTL', async () => {
    const reader = createReader(async () => completeRead(VALID_SETTINGS));
    expect(() => createQuery({ reader, ttlMs: 0 })).toThrow(TypeError);
    await expect(createQuery({ reader, ttlMs: 1 }).getPublicConfig()).resolves.toBeDefined();
  });
});
