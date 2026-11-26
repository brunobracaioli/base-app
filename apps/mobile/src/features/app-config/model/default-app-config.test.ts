import { createDefaultAppConfig } from './default-app-config';

describe('createDefaultAppConfig', () => {
  it('uses permissive version defaults, disables maintenance, and derives legal and store URLs from product config', () => {
    expect(createDefaultAppConfig()).toEqual({
      versions: {
        ios: {
          minSupported: '0.0.0',
          latest: '0.0.0',
          storeUrl: 'https://apps.apple.com/app/id0000000000',
        },
        android: {
          minSupported: '0.0.0',
          latest: '0.0.0',
          storeUrl: 'https://play.google.com/store/apps/details?id=com.example.myapp',
        },
      },
      maintenance: {
        active: false,
        platforms: ['ios', 'android'],
        messageKey: 'maintenance.default',
        until: null,
      },
      legal: {
        termsVersion: '2026-01-01',
        privacyVersion: '2026-01-01',
        termsUrl: 'https://myapp.example.invalid/terms',
        privacyUrl: 'https://myapp.example.invalid/privacy',
      },
    });
  });
});
