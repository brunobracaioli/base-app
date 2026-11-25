import * as z from 'zod';

export const ConsentBody = z.strictObject({
  document: z.enum(['terms', 'privacy']),
  version: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export type ConsentBodyInput = z.infer<typeof ConsentBody>;
