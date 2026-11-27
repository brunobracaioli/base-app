import product from '@base-app/config/product.config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { compareNumericVersions } from './src/features/app-config/model/evaluate-gate';
import eas from './eas.json';
import mobilePackage from './package.json';
import { buildMobileExpoConfig } from './app.config';

describe('mobile Expo config', () => {
  it('uses only caller-provided operational update values and remains non-operational by default', () => {
    const config = buildMobileExpoConfig({});

    expect(config.name).toBe(product.displayName);
    expect(config.slug).toBe(product.slug);
    expect(config.ios?.bundleIdentifier).toBe(product.ios.bundleId);
    expect(config.android?.package).toBe(product.android.package);
    expect(config.updates?.url).toBeUndefined();
    expect(config.updates?.enabled).toBe(false);
    expect(config.runtimeVersion).toEqual({ policy: 'fingerprint' });
    expect(config.extra).toBeUndefined();
  });

  it('declares a version the seeded app-config accepts, so a fresh backend does not block the app', () => {
    // arrange
    const baseline = readFileSync(
      join(
        __dirname,
        '../../supabase/migrations/20261125175958_w2_supabase_compatibility_baseline.sql',
      ),
      'utf8',
    );
    const seeded = [...baseline.matchAll(/"minSupported":"(\d+\.\d+\.\d+)"/g)].map(
      (match) => match[1] ?? '',
    );

    // act
    const config = buildMobileExpoConfig({});

    // assert
    expect(seeded.length).toBeGreaterThan(0);
    for (const minimum of seeded) {
      expect(compareNumericVersions(config.version ?? '', minimum)).toBeGreaterThanOrEqual(0);
    }
  });

  it('disables cleartext and does not enable arbitrary ATS loads', () => {
    const config = buildMobileExpoConfig({});

    expect(config.android?.allowBackup).toBe(false);
    expect(config.plugins).toContainEqual(['./plugins/with-secure-android-backup.cjs']);
    expect(config.ios?.infoPlist?.NSAppTransportSecurity).toBeUndefined();
    expect(config.plugins).toContainEqual(['./plugins/with-no-ios-ats.cjs']);
  });

  it('rejects partial OTA signing inputs instead of enabling unsigned updates', () => {
    expect(() => buildMobileExpoConfig({ EAS_PROJECT_ID: 'caller-project' })).toThrow(/signing/i);
    expect(() =>
      buildMobileExpoConfig({ EXPO_UPDATE_CERTIFICATE_PATH: 'certificate.pem' }),
    ).toThrow(/project/i);
  });

  it('pins the EAS build toolchain to the repository runtime versions', () => {
    expect(eas.build.base).toEqual({ node: '24.22.3', pnpm: '12.23.0', corepack: true });
    expect(eas.build.development.extends).toBe('base');
    expect(eas.build.preview.extends).toBe('base');
    expect(eas.build.production.extends).toBe('base');
  });

  it('builds workspace contracts before app bundling, including EAS post-install', () => {
    expect(mobilePackage.scripts.export).toContain('pnpm run build:runtime-packages');
    expect(mobilePackage.scripts.test).toContain('pnpm run build:runtime-packages');
    expect(mobilePackage.scripts['eas-build-post-install']).toBe('pnpm run build:runtime-packages');
  });
});
