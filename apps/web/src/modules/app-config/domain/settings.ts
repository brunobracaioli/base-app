export const APP_CONFIG_KEYS = ['versions', 'maintenance', 'legal'] as const;

export type AppConfigKey = (typeof APP_CONFIG_KEYS)[number];
export type AppConfigPlatform = 'ios' | 'android';

export type VersionsSetting = {
  readonly ios: PlatformVersionsSetting;
  readonly android: PlatformVersionsSetting;
};

export type PlatformVersionsSetting = {
  readonly minSupported: string;
  readonly latest: string;
  readonly published?: string | undefined;
};

export type MaintenanceSetting = {
  readonly active: boolean;
  readonly platforms: readonly AppConfigPlatform[];
  readonly messageKey: string;
  readonly until: string | null;
};

export type LegalSetting = {
  readonly termsVersion: string;
  readonly privacyVersion: string;
};

export type AppConfigSettings = {
  readonly versions: VersionsSetting;
  readonly maintenance: MaintenanceSetting;
  readonly legal: LegalSetting;
};

export type AppConfigSettingsReadResult = {
  readonly settings: Partial<AppConfigSettings>;
  readonly invalidKeys: readonly AppConfigKey[];
};

export interface AppConfigSettingsReader {
  readAll(): Promise<AppConfigSettingsReadResult>;
}

export type ServerGateDecision =
  | { readonly allow: true }
  | {
      readonly allow: false;
      readonly status: 426 | 503;
      readonly code: 'app.update_required' | 'app.maintenance';
      readonly title: string;
      readonly retryAfterSec?: 60;
    };

export const SAFE_APP_CONFIG_SETTINGS: AppConfigSettings = Object.freeze({
  versions: Object.freeze({
    ios: Object.freeze({ minSupported: '0.0.0', latest: '0.0.0' }),
    android: Object.freeze({ minSupported: '0.0.0', latest: '0.0.0' }),
  }),
  maintenance: Object.freeze({
    active: false,
    platforms: Object.freeze(['ios', 'android'] as const),
    messageKey: 'maintenance.default',
    until: null,
  }),
  legal: Object.freeze({ termsVersion: '2026-01-01', privacyVersion: '2026-01-01' }),
});

function compareUnsignedIntegerStrings(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+/, '') || '0';
  const normalizedRight = right.replace(/^0+/, '') || '0';
  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedLeft.length < normalizedRight.length ? -1 : 1;
  }
  if (normalizedLeft === normalizedRight) return 0;
  return normalizedLeft < normalizedRight ? -1 : 1;
}

export function isSemanticVersion(value: string | null): value is string {
  return value !== null && /^\d+\.\d+\.\d+$/.test(value);
}

export function compareSemanticVersions(left: string, right: string): number {
  const leftParts = left.split('.');
  const rightParts = right.split('.');
  for (let index = 0; index < 3; index += 1) {
    const comparison = compareUnsignedIntegerStrings(
      leftParts[index] ?? '',
      rightParts[index] ?? '',
    );
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function isPlatform(value: string | null): value is AppConfigPlatform {
  return value === 'ios' || value === 'android';
}

function isGlobalMaintenance(settings: MaintenanceSetting): boolean {
  return settings.platforms.includes('ios') && settings.platforms.includes('android');
}

export function evaluateServerGate(input: {
  readonly settings: Pick<AppConfigSettings, 'versions' | 'maintenance'>;
  readonly appVersion: string | null;
  readonly platform: string | null;
  readonly maintenance: 'block' | 'exempt';
}): ServerGateDecision {
  const platform = isPlatform(input.platform) ? input.platform : null;
  if (platform && isSemanticVersion(input.appVersion)) {
    const minimum = input.settings.versions[platform].minSupported;
    if (compareSemanticVersions(input.appVersion, minimum) < 0) {
      return {
        allow: false,
        status: 426,
        code: 'app.update_required',
        title: 'Update required.',
      };
    }
  }

  if (
    input.maintenance === 'block' &&
    input.settings.maintenance.active &&
    (platform
      ? input.settings.maintenance.platforms.includes(platform)
      : isGlobalMaintenance(input.settings.maintenance))
  ) {
    return {
      allow: false,
      status: 503,
      code: 'app.maintenance',
      title: 'Service temporarily unavailable.',
      retryAfterSec: 60,
    };
  }

  return { allow: true };
}
