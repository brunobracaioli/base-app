import * as z from 'zod';

import type {
  AuthMethodEntry,
  BootGate,
  CaptchaProvider,
  I18nNamespace,
  MobileExtension,
  ProviderComponent,
  SettingsItem,
} from './types';

const extensionNamePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const forbiddenPublicKeyParts = ['SECRET', 'KEY_PRIVATE', 'TOKEN'];
const httpsUrlSchema = z.url().refine((value) => {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
});

export const corePublicEnvSchema = z.strictObject({
  EXPO_PUBLIC_API_URL: httpsUrlSchema.optional(),
  EXPO_PUBLIC_SUPABASE_URL: httpsUrlSchema.optional(),
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1).optional(),
  EXPO_PUBLIC_REVENUECAT_IOS_KEY: z.string().min(1).optional(),
  EXPO_PUBLIC_REVENUECAT_ANDROID_KEY: z.string().min(1).optional(),
  EXPO_PUBLIC_SENTRY_DSN: httpsUrlSchema.optional(),
});

export type MobilePublicEnv = z.infer<typeof corePublicEnvSchema> & Record<string, unknown>;

export class MobileExtensionError extends Error {
  constructor(
    readonly code:
      'invalid_extension' | 'duplicate_value' | 'captcha_provider_conflict' | 'invalid_public_env',
  ) {
    super(code);
    this.name = 'MobileExtensionError';
  }
}

export type MobileExtensionRegistry = {
  readonly authMethods: readonly AuthMethodEntry[];
  readonly bootGates: readonly BootGate[];
  readonly settingsItems: readonly SettingsItem[];
  readonly providers: readonly ProviderComponent[];
  readonly i18nNamespaces: readonly I18nNamespace[];
  readonly captchaProvider: CaptchaProvider | null;
  readonly publicEnv: MobilePublicEnv;
};

function assertUnique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) {
    throw new MobileExtensionError('duplicate_value');
  }
}

function extensionPublicKeys(extensions: readonly MobileExtension[]): string[] {
  return extensions.flatMap((extension) =>
    extension.publicEnv === undefined ? [] : Object.keys(extension.publicEnv.shape),
  );
}

function assertPublicEnvNames(keys: readonly string[], coreKeys: readonly string[]): void {
  for (const key of keys) {
    const upperKey = key.toUpperCase();
    if (
      !key.startsWith('EXPO_PUBLIC_') ||
      forbiddenPublicKeyParts.some((part) => upperKey.includes(part))
    ) {
      throw new MobileExtensionError('invalid_public_env');
    }
  }

  assertUnique([...coreKeys, ...keys]);
}

export function composeMobileExtensions(
  extensions: readonly MobileExtension[],
  environment: Readonly<Record<string, string | undefined>>,
): MobileExtensionRegistry {
  for (const extension of extensions) {
    if (!extensionNamePattern.test(extension.name)) {
      throw new MobileExtensionError('invalid_extension');
    }
  }

  assertUnique(extensions.map((extension) => extension.name));

  const authMethods = extensions.flatMap((extension) => [...(extension.authMethods ?? [])]);
  const settingsItems = extensions.flatMap((extension) => [...(extension.settingsItems ?? [])]);
  const bootGates = extensions.flatMap((extension) => [...(extension.bootGates ?? [])]);
  const providers = extensions.flatMap((extension) => [...(extension.providers ?? [])]);
  const i18nNamespaces = extensions.flatMap((extension) => [...(extension.i18nNamespaces ?? [])]);
  const captchaProviders = extensions
    .map((extension) => extension.captchaProvider)
    .filter((provider): provider is CaptchaProvider => provider !== undefined);

  assertUnique(authMethods.map((entry) => entry.id));
  assertUnique(settingsItems.map((item) => item.id));
  assertUnique(i18nNamespaces.map((namespace) => namespace.name));

  if (captchaProviders.length > 1) {
    throw new MobileExtensionError('captcha_provider_conflict');
  }

  const coreKeys = Object.keys(corePublicEnvSchema.shape);
  const extensionKeys = extensionPublicKeys(extensions);
  assertPublicEnvNames(extensionKeys, coreKeys);

  let publicEnv: Record<string, unknown>;
  try {
    const coreEnvironment = Object.fromEntries(
      coreKeys.flatMap((key) => (environment[key] === undefined ? [] : [[key, environment[key]]])),
    );
    publicEnv = corePublicEnvSchema.parse(coreEnvironment);
    for (const extension of extensions) {
      if (extension.publicEnv !== undefined) {
        Object.assign(publicEnv, extension.publicEnv.parse(environment));
      }
    }
  } catch {
    throw new MobileExtensionError('invalid_public_env');
  }

  return {
    authMethods,
    bootGates,
    settingsItems,
    providers,
    i18nNamespaces,
    captchaProvider: captchaProviders[0] ?? null,
    publicEnv: publicEnv as MobilePublicEnv,
  };
}
