import * as z from 'zod';

import { extensionAuthMethods, extensionConfigSchema } from './extensions.js';

const supportedCoreAuthMethods = ['email_otp', 'email_password'] as const;
const supportedAuthMethods = new Set<string>([
  ...supportedCoreAuthMethods,
  ...extensionAuthMethods,
]);

const slugSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const reverseDnsSchema = z.string().regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+$/i);
const androidPackageSchema = z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/i);
const appStoreIdSchema = z.string().regex(/^\d{1,20}$/);
const schemeSchema = z.string().regex(/^[a-z][a-z0-9+.-]*$/i);
const publicProjectIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);

const httpsOriginSchema = z.url().superRefine((value, context) => {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== 'https:' ||
      parsed.origin !== value ||
      parsed.username !== '' ||
      parsed.password !== ''
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Expected an HTTPS origin without credentials, path, query, or fragment',
      });
    }
  } catch {
    context.addIssue({ code: 'custom', message: 'Expected a valid HTTPS origin' });
  }
});

const legalPathSchema = z
  .string()
  .regex(/^\/(?!\/)[a-zA-Z0-9/_-]*$/)
  .refine((value) => !value.split('/').some((segment) => segment === '..'), {
    message: 'Legal paths must stay within the application origin',
  });

const authSchema = z
  .strictObject({
    methods: z.array(z.string().min(1)).min(1),
    recentAuthMaxAgeSec: z.number().int().min(60).max(900).default(300),
  })
  .superRefine((auth, context) => {
    if (new Set(auth.methods).size !== auth.methods.length) {
      context.addIssue({
        code: 'custom',
        path: ['methods'],
        message: 'Authentication methods must be unique',
      });
    }

    auth.methods.forEach((method, index) => {
      if (!supportedAuthMethods.has(method)) {
        context.addIssue({
          code: 'custom',
          path: ['methods', index],
          message: `Unsupported authentication method: ${method}`,
        });
      }
    });
  });

const quotaSchema = z
  .strictObject({
    perDay: z.record(z.string().min(1), z.number().int().min(1).max(1_000_000)),
    globalPerDay: z.number().int().min(1).max(1_000_000),
  })
  .refine((quota) => Object.keys(quota.perDay).length > 0, {
    path: ['perDay'],
    message: 'Each quota must define at least one per-entitlement limit',
  });

const quotasSchema = z.record(z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/), quotaSchema);

const environmentSchema = z.strictObject({
  supabaseUrl: httpsOriginSchema,
  revenuecatProjectId: publicProjectIdSchema,
});

export const productConfigSchema = z
  .strictObject({
    slug: slugSchema,
    displayName: z.string().trim().min(1).max(80),
    ios: z.strictObject({
      bundleId: reverseDnsSchema,
      appStoreId: appStoreIdSchema,
    }),
    android: z.strictObject({ package: androidPackageSchema }),
    scheme: schemeSchema,
    web: z.strictObject({ origin: httpsOriginSchema }),
    locales: z.array(z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)).min(1),
    defaultLocale: z.string().min(2),
    auth: authSchema,
    billing: z.strictObject({
      entitlements: z.array(z.string().min(1).max(100)).max(10),
      cacheTtlSec: z.number().int().min(15).max(300).default(60),
    }),
    environments: z.strictObject({
      production: environmentSchema,
      staging: environmentSchema,
    }),
    quotas: quotasSchema,
    legal: z.strictObject({
      termsPath: legalPathSchema,
      privacyPath: legalPathSchema,
    }),
    extensions: extensionConfigSchema,
  })
  .superRefine((product, context) => {
    if (new Set(product.locales).size !== product.locales.length) {
      context.addIssue({ code: 'custom', path: ['locales'], message: 'Locales must be unique' });
    }

    if (!product.locales.includes(product.defaultLocale)) {
      context.addIssue({
        code: 'custom',
        path: ['defaultLocale'],
        message: 'The default locale must be present in locales',
      });
    }

    if (new Set(product.billing.entitlements).size !== product.billing.entitlements.length) {
      context.addIssue({
        code: 'custom',
        path: ['billing', 'entitlements'],
        message: 'Entitlements must be unique',
      });
    }

    if (Object.keys(product.quotas).length > 20) {
      context.addIssue({
        code: 'custom',
        path: ['quotas'],
        message: 'At most 20 quotas may be configured',
      });
    }

    for (const [quotaName, quota] of Object.entries(product.quotas)) {
      for (const entitlement of Object.keys(quota.perDay)) {
        if (!product.billing.entitlements.includes(entitlement)) {
          context.addIssue({
            code: 'custom',
            path: ['quotas', quotaName, 'perDay', entitlement],
            message: 'Quota entitlement must exist in billing.entitlements',
          });
        }
      }
    }
  });

export type ProductConfigInput = z.input<typeof productConfigSchema>;
export type ProductConfig = z.output<typeof productConfigSchema>;

export function defineProduct(input: ProductConfigInput): ProductConfig {
  return productConfigSchema.parse(input);
}
