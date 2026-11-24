import * as z from 'zod';

/**
 * Extension configuration starts empty in the base app. A derived app owns
 * the schema for each value it adds here.
 */
export const extensionConfigSchema = z.strictObject({});

/** Additional auth method IDs contributed by the current derived app. */
export const extensionAuthMethods = [] as const;

export type ExtensionConfig = z.infer<typeof extensionConfigSchema>;
export type ExtensionAuthMethod = (typeof extensionAuthMethods)[number];
