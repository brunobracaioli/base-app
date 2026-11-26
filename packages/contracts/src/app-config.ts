import * as z from 'zod';

/** Semantic version components are compared numerically by decimal digit length and value. */
export const SemVer = z.string().regex(/^\d+\.\d+\.\d+$/);

/** Mobile platforms supported by the base app. */
export const Platform = z.enum(['ios', 'android']);

function compareNumericComponents(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+/, '') || '0';
  const normalizedRight = right.replace(/^0+/, '') || '0';

  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedLeft.length < normalizedRight.length ? -1 : 1;
  }
  if (normalizedLeft === normalizedRight) return 0;
  return normalizedLeft < normalizedRight ? -1 : 1;
}

function compareSemVer(left: string, right: string): number {
  const leftComponents = left.split('.');
  const rightComponents = right.split('.');

  for (let index = 0; index < 3; index += 1) {
    const leftComponent = leftComponents[index] ?? '';
    const rightComponent = rightComponents[index] ?? '';
    const comparison = compareNumericComponents(leftComponent, rightComponent);
    if (comparison !== 0) return comparison;
  }

  return 0;
}

function isCalendarValidIsoDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isCalendarValidIsoDate, { message: 'Expected a calendar-valid ISO date.' });

const PlatformVersions = z.strictObject({
  minSupported: SemVer,
  latest: SemVer,
  published: SemVer.optional(),
});

/** Stored minimum/latest/published version settings, with the cross-field gate invariant. */
export const VersionsSetting = z
  .strictObject({
    ios: PlatformVersions,
    android: PlatformVersions,
  })
  .superRefine((versions, context) => {
    for (const platform of Platform.options) {
      if (compareSemVer(versions[platform].minSupported, versions[platform].latest) > 0) {
        context.addIssue({
          code: 'custom',
          path: [platform, 'minSupported'],
          message: 'minSupported must be less than or equal to latest.',
        });
      }
    }
  });

/** Stored maintenance settings, normalized with safe defaults for optional fields. */
export const MaintenanceSetting = z.strictObject({
  active: z.boolean(),
  platforms: z.array(Platform).min(1).default(['ios', 'android']),
  messageKey: z
    .string()
    .regex(/^maintenance\.[a-z0-9_]{1,60}$/)
    .default('maintenance.default'),
  until: z.iso.datetime().nullable().default(null),
});

/** Stored current legal document versions. */
export const LegalSetting = z.strictObject({
  termsVersion: IsoDate,
  privacyVersion: IsoDate,
});

const AppConfigPlatformVersion = z.strictObject({
  minSupported: SemVer,
  latest: SemVer,
  storeUrl: z.url(),
});

/** Public, normalized remote configuration consumed by clients and the server gate. */
export const AppConfigResponse = z
  .strictObject({
    versions: z.strictObject({
      ios: AppConfigPlatformVersion,
      android: AppConfigPlatformVersion,
    }),
    maintenance: z.strictObject({
      active: z.boolean(),
      platforms: z.array(Platform),
      messageKey: z.string(),
      until: z.iso.datetime().nullable(),
    }),
    legal: z.strictObject({
      termsVersion: IsoDate,
      privacyVersion: IsoDate,
      termsUrl: z.url(),
      privacyUrl: z.url(),
    }),
  })
  .superRefine((config, context) => {
    for (const platform of Platform.options) {
      if (
        compareSemVer(config.versions[platform].minSupported, config.versions[platform].latest) > 0
      ) {
        context.addIssue({
          code: 'custom',
          path: ['versions', platform, 'minSupported'],
          message: 'minSupported must be less than or equal to latest.',
        });
      }
    }
  });

export type SemVerValue = z.infer<typeof SemVer>;
export type PlatformValue = z.infer<typeof Platform>;
export type VersionsSettingValue = z.infer<typeof VersionsSetting>;
export type MaintenanceSettingValue = z.infer<typeof MaintenanceSetting>;
export type LegalSettingValue = z.infer<typeof LegalSetting>;
export type AppConfigResponseValue = z.infer<typeof AppConfigResponse>;
