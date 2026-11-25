import {
  LegalSetting,
  MaintenanceSetting,
  VersionsSetting,
} from '@base-app/contracts';
import type {
  LegalSettingValue,
  MaintenanceSettingValue,
  VersionsSettingValue,
} from '@base-app/contracts';
import type { createDatabase } from '../../../platform/db';
import { APP_CONFIG_KEYS } from '../domain/settings';
import type {
  AppConfigKey,
  AppConfigSettings,
  AppConfigSettingsReadResult,
  AppConfigSettingsReader,
} from '../domain/settings';

export { APP_CONFIG_KEYS };

export const appConfigValueSchemas = Object.freeze({
  versions: VersionsSetting,
  maintenance: MaintenanceSetting,
  legal: LegalSetting,
});

export type AppConfigValueByKey = {
  readonly versions: VersionsSettingValue;
  readonly maintenance: MaintenanceSettingValue;
  readonly legal: LegalSettingValue;
};

type CoreDatabase = ReturnType<typeof createDatabase>;

type ParsedAppConfigRow =
  | { readonly key: 'versions'; readonly value: VersionsSettingValue }
  | { readonly key: 'maintenance'; readonly value: MaintenanceSettingValue }
  | { readonly key: 'legal'; readonly value: LegalSettingValue };

function parseRow(key: AppConfigKey, value: unknown): ParsedAppConfigRow | undefined {
  switch (key) {
    case 'versions': {
      const parsed = VersionsSetting.safeParse(value);
      return parsed.success ? { key, value: parsed.data } : undefined;
    }
    case 'maintenance': {
      const parsed = MaintenanceSetting.safeParse(value);
      return parsed.success ? { key, value: parsed.data } : undefined;
    }
    case 'legal': {
      const parsed = LegalSetting.safeParse(value);
      return parsed.success ? { key, value: parsed.data } : undefined;
    }
  }
}

export function createAppConfigSettingsReader(
  database: Pick<CoreDatabase, 'systemDb'>,
): AppConfigSettingsReader {
  return Object.freeze({
    async readAll(): Promise<AppConfigSettingsReadResult> {
      const rows = await database.systemDb('app-config', async (transaction) =>
        transaction
          .selectFrom('app_config.settings')
          .select(['key', 'value'])
          .where('key', 'in', [...APP_CONFIG_KEYS])
          .execute(),
      );

      const rowsByKey = new Map<AppConfigKey, unknown[]>();
      for (const row of rows) {
        if (!APP_CONFIG_KEYS.includes(row.key as AppConfigKey)) continue;
        const key = row.key as AppConfigKey;
        const matching = rowsByKey.get(key) ?? [];
        matching.push(row.value);
        rowsByKey.set(key, matching);
      }

      const settings: { -readonly [Key in keyof AppConfigSettings]?: AppConfigSettings[Key] } = {};
      const invalidKeys: AppConfigKey[] = [];
      for (const key of APP_CONFIG_KEYS) {
        const values = rowsByKey.get(key);
        if (!values || values.length !== 1) {
          invalidKeys.push(key);
          continue;
        }
        const parsed = parseRow(key, values[0]);
        if (!parsed) {
          invalidKeys.push(key);
          continue;
        }
        switch (parsed.key) {
          case 'versions':
            settings.versions = parsed.value;
            break;
          case 'maintenance':
            settings.maintenance = parsed.value;
            break;
          case 'legal':
            settings.legal = parsed.value;
            break;
        }
      }

      return { settings, invalidKeys };
    },
  });
}
