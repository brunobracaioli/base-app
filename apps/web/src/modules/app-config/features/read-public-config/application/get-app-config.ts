import { AppConfigResponse } from '@base-app/contracts';
import type { AppConfigResponseValue } from '@base-app/contracts';

import {
  APP_CONFIG_KEYS,
  SAFE_APP_CONFIG_SETTINGS,
  evaluateServerGate,
} from '../../../domain/settings';
import type {
  AppConfigKey,
  AppConfigSettings,
  AppConfigSettingsReader,
  ServerGateDecision,
} from '../../../domain/settings';

export const APP_CONFIG_CACHE_TTL_MS = 30_000;

export type AppConfigProductUrls = {
  readonly iosStoreUrl: string;
  readonly androidStoreUrl: string;
  readonly termsUrl: string;
  readonly privacyUrl: string;
};

export type AppConfigObserver = {
  readonly invalidSetting: (key: AppConfigKey) => void;
  readonly readFailed: (error: unknown) => void;
};

export type AppConfigClock = { readonly now: () => Date };

function copySetting<Key extends AppConfigKey>(
  key: Key,
  setting: AppConfigSettings[Key],
): AppConfigSettings[Key] {
  switch (key) {
    case 'versions': {
      const versions = setting as AppConfigSettings['versions'];
      return {
        ios: { ...versions.ios },
        android: { ...versions.android },
      } as unknown as AppConfigSettings[Key];
    }
    case 'maintenance': {
      const maintenance = setting as AppConfigSettings['maintenance'];
      return {
        ...maintenance,
        platforms: [...maintenance.platforms],
      } as unknown as AppConfigSettings[Key];
    }
    case 'legal':
      return { ...(setting as AppConfigSettings['legal']) } as unknown as AppConfigSettings[Key];
  }
}

function safeSetting<Key extends AppConfigKey>(key: Key): AppConfigSettings[Key] {
  return copySetting(key, SAFE_APP_CONFIG_SETTINGS[key]);
}

export function createAppConfigQuery(input: {
  readonly reader: AppConfigSettingsReader;
  readonly productUrls: AppConfigProductUrls;
  readonly clock: AppConfigClock;
  readonly observer?: AppConfigObserver;
  readonly ttlMs?: number;
}) {
  const ttlMs = input.ttlMs ?? APP_CONFIG_CACHE_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 60_000) {
    throw new TypeError('App config cache TTL must be between 1 and 60000 milliseconds.');
  }

  const observer = input.observer ?? { invalidSetting() {}, readFailed() {} };
  const lastValid: Partial<AppConfigSettings> = {};
  let cachedSettings: AppConfigSettings | undefined;
  let expiresAtMs = 0;
  let refreshInFlight: Promise<AppConfigSettings> | undefined;

  function reportInvalid(key: AppConfigKey): void {
    try {
      observer.invalidSetting(key);
    } catch {
      // Observability must not affect the safe config response.
    }
  }

  function reportReadFailure(error: unknown): void {
    try {
      observer.readFailed(error);
    } catch {
      // Observability must not affect the safe config response.
    }
  }

  function fallbackSettings(): AppConfigSettings {
    return {
      versions: copySetting('versions', lastValid.versions ?? safeSetting('versions')),
      maintenance: copySetting(
        'maintenance',
        lastValid.maintenance ?? safeSetting('maintenance'),
      ),
      legal: copySetting('legal', lastValid.legal ?? safeSetting('legal')),
    };
  }

  function resolveKey<Key extends AppConfigKey>(
    key: Key,
    candidate: AppConfigSettings[Key] | undefined,
    invalidKeys: ReadonlySet<AppConfigKey>,
  ): AppConfigSettings[Key] {
    if (candidate !== undefined && !invalidKeys.has(key)) {
      const valid = copySetting(key, candidate);
      lastValid[key] = valid;
      return copySetting(key, valid);
    }
    reportInvalid(key);
    const lastKnown = lastValid[key];
    return copySetting(key, lastKnown ?? safeSetting(key));
  }

  async function refreshSettings(): Promise<AppConfigSettings> {
    let result;
    try {
      result = await input.reader.readAll();
    } catch (error) {
      reportReadFailure(error);
      return fallbackSettings();
    }

    const invalidKeys = new Set(result.invalidKeys);
    for (const key of APP_CONFIG_KEYS) {
      if (result.settings[key] === undefined) invalidKeys.add(key);
    }
    return {
      versions: resolveKey('versions', result.settings.versions, invalidKeys),
      maintenance: resolveKey('maintenance', result.settings.maintenance, invalidKeys),
      legal: resolveKey('legal', result.settings.legal, invalidKeys),
    };
  }

  async function getSettings(): Promise<AppConfigSettings> {
    const nowMs = input.clock.now().getTime();
    if (cachedSettings !== undefined && nowMs < expiresAtMs) return cachedSettings;
    if (refreshInFlight !== undefined) return refreshInFlight;

    const pending = refreshSettings().then((settings) => {
      cachedSettings = settings;
      expiresAtMs = input.clock.now().getTime() + ttlMs;
      return settings;
    });
    refreshInFlight = pending;
    try {
      return await pending;
    } finally {
      if (refreshInFlight === pending) refreshInFlight = undefined;
    }
  }

  async function getPublicConfig(): Promise<AppConfigResponseValue> {
    const settings = await getSettings();
    return AppConfigResponse.parse({
      versions: {
        ios: {
          minSupported: settings.versions.ios.minSupported,
          latest: settings.versions.ios.latest,
          storeUrl: input.productUrls.iosStoreUrl,
        },
        android: {
          minSupported: settings.versions.android.minSupported,
          latest: settings.versions.android.latest,
          storeUrl: input.productUrls.androidStoreUrl,
        },
      },
      maintenance: {
        active: settings.maintenance.active,
        platforms: [...settings.maintenance.platforms],
        messageKey: settings.maintenance.messageKey,
        until: settings.maintenance.until,
      },
      legal: {
        termsVersion: settings.legal.termsVersion,
        privacyVersion: settings.legal.privacyVersion,
        termsUrl: input.productUrls.termsUrl,
        privacyUrl: input.productUrls.privacyUrl,
      },
    });
  }

  async function checkGate(gate: {
    readonly appVersion: string | null;
    readonly platform: string | null;
    readonly maintenance: 'block' | 'exempt';
  }): Promise<ServerGateDecision> {
    return evaluateServerGate({
      settings: await getSettings(),
      ...gate,
    });
  }

  return Object.freeze({ getPublicConfig, checkGate });
}
