import 'tsx/cjs';

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ConfigContext, ExpoConfig } from 'expo/config';
import type { ProductConfig } from '@base-app/config';

const configRequire = createRequire(resolve(process.cwd(), 'package.json'));
const product = (configRequire('@base-app/config/product.config') as { default: ProductConfig })
  .default;

export type MobileConfigEnvironment = Readonly<Record<string, string | undefined>>;

function requiredString(environment: MobileConfigEnvironment, key: string): string | undefined {
  const value = environment[key]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function resolveSignedUpdates(environment: MobileConfigEnvironment): {
  readonly enabled: boolean;
  readonly url?: string;
  readonly certificate?: string;
  readonly keyId?: string;
  readonly projectId?: string;
} {
  const projectId = requiredString(environment, 'EAS_PROJECT_ID');
  const updateUrl = requiredString(environment, 'EXPO_UPDATE_URL');
  const certificate = requiredString(environment, 'EXPO_UPDATE_CERTIFICATE_PATH');
  const keyId = requiredString(environment, 'EXPO_UPDATE_KEY_ID');
  const configured =
    projectId !== undefined ||
    updateUrl !== undefined ||
    certificate !== undefined ||
    keyId !== undefined;

  if (!configured) {
    return { enabled: false };
  }
  if (projectId === undefined) {
    throw new Error('EAS_PROJECT_ID is required to configure signed OTA updates.');
  }
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(projectId)) {
    throw new Error('EAS_PROJECT_ID has an invalid format.');
  }
  if (certificate === undefined || keyId === undefined) {
    throw new Error('A caller-provided OTA signing certificate and key id are required.');
  }

  const certificatePath = resolve(process.cwd(), certificate);
  if (!existsSync(certificatePath)) {
    throw new Error('The caller-provided OTA signing certificate was not found.');
  }

  const resolvedUrl = updateUrl ?? `https://u.expo.dev/${projectId}`;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(resolvedUrl);
  } catch {
    throw new Error('EXPO_UPDATE_URL must be a valid HTTPS URL.');
  }
  if (parsedUrl.protocol !== 'https:') {
    throw new Error('EXPO_UPDATE_URL must use HTTPS.');
  }

  return {
    enabled: true,
    url: resolvedUrl,
    certificate,
    keyId,
    projectId,
  };
}

export function buildMobileExpoConfig(environment: MobileConfigEnvironment): ExpoConfig {
  const signedUpdates = resolveSignedUpdates(environment);
  const updates = {
    enabled: signedUpdates.enabled,
    checkAutomatically: 'ON_LOAD' as const,
    fallbackToCacheTimeout: 0,
    ...(signedUpdates.enabled &&
    signedUpdates.url !== undefined &&
    signedUpdates.certificate !== undefined &&
    signedUpdates.keyId !== undefined
      ? {
          url: signedUpdates.url,
          codeSigningCertificate: signedUpdates.certificate,
          codeSigningMetadata: {
            keyid: signedUpdates.keyId,
            alg: 'rsa-v1_5-sha256' as const,
          },
        }
      : {}),
  };

  return {
    name: product.displayName,
    slug: product.slug,
    scheme: product.scheme,
    version: '0.0.0',
    orientation: 'portrait',
    userInterfaceStyle: 'automatic',
    platforms: ['ios', 'android'],
    plugins: [
      ['./plugins/with-secure-android-backup.cjs'],
      ['expo-router', { root: './src/app' }],
      [
        'expo-build-properties',
        {
          android: {
            enableProguardInReleaseBuilds: true,
            enableShrinkResourcesInReleaseBuilds: true,
          },
        },
      ],
      'expo-updates',
      ['@sentry/react-native/expo', { disableAutoUpload: true }],
      ['./plugins/with-no-ios-ats.cjs'],
    ],
    ios: {
      bundleIdentifier: product.ios.bundleId,
    },
    android: {
      package: product.android.package,
      allowBackup: false,
    },
    experiments: {
      typedRoutes: true,
      tsconfigPaths: true,
    },
    updates,
    runtimeVersion: { policy: 'fingerprint' },
    ...(signedUpdates.projectId === undefined
      ? {}
      : { extra: { eas: { projectId: signedUpdates.projectId } } }),
  };
}

export default function appConfig({ config }: ConfigContext): ExpoConfig {
  return { ...config, ...buildMobileExpoConfig(process.env) };
}
