import * as z from 'zod';

const dbClaimsSchema = z
  .object({
    sub: z.uuid(),
    role: z.literal('authenticated'),
    aal: z.enum(['aal1', 'aal2']),
    session_id: z.uuid(),
  })
  .strict();

export type DbClaims = z.infer<typeof dbClaimsSchema>;

export function parseUserDbClaims(input: unknown): DbClaims {
  const result = dbClaimsSchema.safeParse(input);
  if (!result.success) throw new TypeError('Invalid database user claims.');
  return result.data;
}
