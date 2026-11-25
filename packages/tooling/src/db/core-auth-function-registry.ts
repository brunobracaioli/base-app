import { z } from 'zod';

const coreAuthFunctionPolicies = new Map([
  ['identity.before_user_created(jsonb)', { executeCallers: ['supabase_auth_admin'] as const }],
  ['identity.count_unconfirmed_users()', { executeCallers: ['ops'] as const }],
  ['identity.delete_unconfirmed_users()', { executeCallers: ['ops'] as const }],
]);

const coreAuthFunctionEntrySchema = z
  .object({
    schema: z.literal('identity'),
    name: z.string().regex(/^[a-z][a-z0-9_]*$/),
    signature: z
      .string()
      .regex(/^\([^;]*\)$/)
      .max(200),
    migration: z.string().regex(/^\d{14}_[a-z][a-z0-9_-]*\.sql$/),
    owner: z.literal('postgres'),
    executeCallers: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).min(1),
    purpose: z.string().trim().min(1).max(512),
  })
  .strict();

const coreAuthFunctionRegistrySchema = z
  .object({
    functions: z.array(coreAuthFunctionEntrySchema),
  })
  .strict();

export type CoreAuthFunctionRegistryEntry = z.infer<typeof coreAuthFunctionEntrySchema>;

function identityOf(
  entry: Pick<CoreAuthFunctionRegistryEntry, 'schema' | 'name' | 'signature'>,
): string {
  return `${entry.schema}.${entry.name}${entry.signature.replaceAll(' ', '')}`;
}

/**
 * Validate the closed W2 core Auth-definer registry without importing the SQL parser.
 * The function identities and exact executor sets are deliberately not data-extensible.
 */
export function parseCoreAuthFunctionRegistryDocument(
  document: unknown,
): CoreAuthFunctionRegistryEntry[] {
  const parsed = coreAuthFunctionRegistrySchema.safeParse(document);
  if (!parsed.success) throw new Error('Invalid core Auth-function registry shape.');

  const registrations: CoreAuthFunctionRegistryEntry[] = [];
  const seen = new Set<string>();
  for (const entry of parsed.data.functions) {
    const identity = identityOf(entry);
    const policy = coreAuthFunctionPolicies.get(identity);
    if (policy === undefined)
      throw new Error(`Core Auth-function registry entry is not allowlisted: ${identity}.`);
    if (seen.has(identity))
      throw new Error(`Duplicate core Auth-function registry entry: ${identity}.`);
    if (JSON.stringify(entry.executeCallers) !== JSON.stringify(policy.executeCallers))
      throw new Error(`Core Auth-function callers do not match the fixed policy: ${identity}.`);
    if (entry.migration.includes('_ext-'))
      throw new Error(`Core Auth-function migration must be a core migration: ${entry.migration}.`);
    seen.add(identity);
    registrations.push({ ...entry, signature: entry.signature.replaceAll(' ', '') });
  }
  if (seen.size !== coreAuthFunctionPolicies.size)
    throw new Error('Core Auth-function registry must contain the complete fixed W2 function set.');
  return registrations.sort((left, right) => identityOf(left).localeCompare(identityOf(right)));
}
