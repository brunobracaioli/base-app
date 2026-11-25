export { createAppConfigQuery, APP_CONFIG_CACHE_TTL_MS } from './features/read-public-config/application/get-app-config';
export type {
  AppConfigClock,
  AppConfigObserver,
  AppConfigProductUrls,
} from './features/read-public-config/application/get-app-config';
export { createAppConfigSettingsReader, appConfigValueSchemas } from './infrastructure/settings-reader';
export type { AppConfigValueByKey } from './infrastructure/settings-reader';
export { APP_CONFIG_KEYS } from './domain/settings';
export type {
  AppConfigKey,
  AppConfigSettings,
  AppConfigSettingsReadResult,
  AppConfigSettingsReader,
  ServerGateDecision,
} from './domain/settings';
export { evaluateServerGate, compareSemanticVersions, isSemanticVersion } from './domain/settings';
export { createLegalVersionsReader } from './infrastructure/legal-versions-reader';
export type { LegalVersionsReader } from './infrastructure/legal-versions-reader';
export type { LegalVersions } from './domain/legal-versions';
export { InvalidLegalVersionsError, parseLegalVersions } from './domain/legal-versions';
