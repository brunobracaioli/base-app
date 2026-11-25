import product from '@base-app/config/product.config';
import * as z from 'zod';

const [firstLocale, ...remainingLocales] = product.locales;

if (firstLocale === undefined) {
  throw new Error('The product configuration must define at least one locale.');
}

/** The locale contract follows the active product configuration. */
export const Locale = z.enum([firstLocale, ...remainingLocales]);

export const Me = z.strictObject({
  id: z.string().uuid(),
  email: z.email().nullable(),
  displayName: z.string().min(1).max(80).nullable(),
  locale: Locale,
  createdAt: z.iso.datetime().describe('Creation time of the identity.profiles row.'),
  consents: z.strictObject({
    needsAcceptance: z.array(z.enum(['terms', 'privacy'])),
  }),
});

export const UpdateProfileBody = z
  .strictObject({
    displayName: z.string().trim().min(1).max(80).nullable().optional(),
    locale: Locale.optional(),
  })
  .refine((body) => body.displayName !== undefined || body.locale !== undefined, {
    message: 'At least one profile field is required.',
  });

export type MeResponse = z.infer<typeof Me>;
export type UpdateProfileBodyInput = z.infer<typeof UpdateProfileBody>;
