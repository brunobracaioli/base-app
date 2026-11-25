import { describe, expect, it } from 'vitest';
import { APP_CONFIG_KEYS as PUBLIC_APP_CONFIG_KEYS, appConfigValueSchemas } from '..';

import {
  APP_CONFIG_KEYS,
  SAFE_APP_CONFIG_SETTINGS,
  compareSemanticVersions,
  evaluateServerGate,
  isSemanticVersion,
} from '../domain/settings';

describe('app-config domain settings', () => {
  it('declares only the three supported settings and keeps an unblockable safe default', () => {
    expect(APP_CONFIG_KEYS).toEqual(['versions', 'maintenance', 'legal']);
    expect(SAFE_APP_CONFIG_SETTINGS.versions.ios).toEqual({
      minSupported: '0.0.0',
      latest: '0.0.0',
    });
    expect(SAFE_APP_CONFIG_SETTINGS.maintenance.active).toBe(false);
    expect(SAFE_APP_CONFIG_SETTINGS.maintenance.platforms).toEqual(['ios', 'android']);
    expect(SAFE_APP_CONFIG_SETTINGS.legal).toEqual({
      termsVersion: '2026-01-01',
      privacyVersion: '2026-01-01',
    });
  });

  it('compares arbitrarily large semantic version components without number overflow', () => {
    expect(isSemanticVersion(null)).toBe(false);
    expect(isSemanticVersion('1.2.3')).toBe(true);
    expect(isSemanticVersion('1.2')).toBe(false);
    expect(compareSemanticVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareSemanticVersions('1.9.0', '1.10.0')).toBeLessThan(0);
    expect(compareSemanticVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareSemanticVersions('1.9007199254740993.0', '1.9007199254740992.999')).toBeGreaterThan(0);
    expect(compareSemanticVersions('01.000.2', '1.0.2')).toBe(0);
    expect(compareSemanticVersions('1', '1.0.0')).toBe(0);
  });

  it('applies a platform update minimum before maintenance', () => {
    expect(
      evaluateServerGate({
        settings: {
          versions: {
            ios: { minSupported: '1.10.0', latest: '2.0.0' },
            android: { minSupported: '1.0.0', latest: '2.0.0' },
          },
          maintenance: {
            active: true,
            platforms: ['ios'],
            messageKey: 'maintenance.default',
            until: null,
          },
        },
        appVersion: '1.9.0',
        platform: 'ios',
        maintenance: 'block',
      }),
    ).toMatchObject({ status: 426, code: 'app.update_required' });
  });

  it('applies platform-only and global maintenance, including missing platform headers', () => {
    const platformMaintenance = {
      versions: SAFE_APP_CONFIG_SETTINGS.versions,
      maintenance: {
        active: true,
        platforms: ['ios'] as const,
        messageKey: 'maintenance.ios_only',
        until: null,
      },
    };
    expect(
      evaluateServerGate({
        settings: platformMaintenance,
        appVersion: null,
        platform: 'ios',
        maintenance: 'block',
      }),
    ).toMatchObject({ status: 503, code: 'app.maintenance', retryAfterSec: 60 });
    expect(
      evaluateServerGate({
        settings: platformMaintenance,
        appVersion: null,
        platform: null,
        maintenance: 'block',
      }),
    ).toEqual({ allow: true });

    expect(
      evaluateServerGate({
        settings: {
          versions: SAFE_APP_CONFIG_SETTINGS.versions,
          maintenance: {
            ...platformMaintenance.maintenance,
            platforms: ['android', 'ios'],
          },
        },
        appVersion: null,
        platform: null,
        maintenance: 'block',
      }),
    ).toMatchObject({ status: 503 });
  });

  it('does not gate invalid headers and does not let a maintenance exemption bypass the version gate', () => {
    const settings = {
      versions: {
        ios: { minSupported: '1.5.0', latest: '2.0.0' },
        android: { minSupported: '1.0.0', latest: '2.0.0' },
      },
      maintenance: {
        active: true,
        platforms: ['ios', 'android'] as const,
        messageKey: 'maintenance.default',
        until: null,
      },
    };
    expect(
      evaluateServerGate({
        settings,
        appVersion: '1.0.0',
        platform: 'web',
        maintenance: 'block',
      }),
    ).toMatchObject({ status: 503 });
    expect(
      evaluateServerGate({
        settings,
        appVersion: 'invalid',
        platform: 'ios',
        maintenance: 'exempt',
      }),
    ).toEqual({ allow: true });
    expect(
      evaluateServerGate({
        settings,
        appVersion: '1.0.0',
        platform: 'ios',
        maintenance: 'exempt',
      }),
    ).toMatchObject({ status: 426 });
  });
});

describe('app-config module public setting contracts', () => {
  it('exports the closed setting allowlist and its matching Zod schemas', async () => {
    const keys = PUBLIC_APP_CONFIG_KEYS;
    expect(keys).toEqual(['versions', 'maintenance', 'legal']);
    expect(Object.keys(appConfigValueSchemas)).toEqual([...keys]);
    expect(appConfigValueSchemas.versions.safeParse(SAFE_APP_CONFIG_SETTINGS.versions).success).toBe(
      true,
    );
    expect(appConfigValueSchemas.maintenance.safeParse(SAFE_APP_CONFIG_SETTINGS.maintenance).success).toBe(
      true,
    );
    expect(appConfigValueSchemas.legal.safeParse(SAFE_APP_CONFIG_SETTINGS.legal).success).toBe(true);
  });
});
