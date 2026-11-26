import { evaluateGate } from './evaluate-gate';

function makeConfig(
  overrides: Partial<{
    readonly minSupported: string;
    readonly latest: string;
    readonly maintenanceActive: boolean;
    readonly platforms: Array<'ios' | 'android'>;
  }> = {},
) {
  const {
    minSupported = '0.0.0',
    latest = '1.0.0',
    maintenanceActive = false,
    platforms = ['ios', 'android'],
  } = overrides;

  return {
    versions: {
      ios: {
        minSupported,
        latest,
        storeUrl: 'https://apps.apple.com/app/id0000000000',
      },
      android: {
        minSupported,
        latest,
        storeUrl: 'https://play.google.com/store/apps/details?id=com.example.myapp',
      },
    },
    maintenance: {
      active: maintenanceActive,
      platforms,
      messageKey: 'maintenance.default',
      until: null,
    },
    legal: {
      termsVersion: '2026-01-01',
      privacyVersion: '2026-01-01',
      termsUrl: 'https://myapp.example.invalid/terms',
      privacyUrl: 'https://myapp.example.invalid/privacy',
    },
  };
}

describe('evaluateGate', () => {
  it('compares numeric version components instead of strings', () => {
    expect(
      evaluateGate(makeConfig({ minSupported: '1.9.0' }), {
        appVersion: '1.10.0',
        platform: 'ios',
      }),
    ).toBe('ok');
  });

  it('requires an update only when the installed version is below the platform minimum', () => {
    expect(
      evaluateGate(makeConfig({ minSupported: '1.10.0' }), {
        appVersion: '1.9.99',
        platform: 'android',
      }),
    ).toBe('update');
    expect(
      evaluateGate(makeConfig({ minSupported: '1.10.0' }), {
        appVersion: '1.10.0',
        platform: 'android',
      }),
    ).toBe('ok');
  });

  it('gives update precedence over maintenance', () => {
    expect(
      evaluateGate(makeConfig({ minSupported: '2.0.0', maintenanceActive: true }), {
        appVersion: '1.0.0',
        platform: 'ios',
      }),
    ).toBe('update');
  });

  it('applies maintenance only to platforms listed by the response', () => {
    expect(
      evaluateGate(makeConfig({ maintenanceActive: true, platforms: ['ios'] }), {
        appVersion: '1.0.0',
        platform: 'ios',
      }),
    ).toBe('maintenance');
    expect(
      evaluateGate(makeConfig({ maintenanceActive: true, platforms: ['ios'] }), {
        appVersion: '1.0.0',
        platform: 'android',
      }),
    ).toBe('ok');
  });

  it('does not apply cached maintenance while offline, but still enforces a cached update', () => {
    expect(
      evaluateGate(makeConfig({ maintenanceActive: true }), {
        appVersion: '1.0.0',
        platform: 'ios',
        offline: true,
      }),
    ).toBe('ok');
    expect(
      evaluateGate(makeConfig({ minSupported: '2.0.0' }), {
        appVersion: '1.0.0',
        platform: 'ios',
        offline: true,
      }),
    ).toBe('update');
  });
});
