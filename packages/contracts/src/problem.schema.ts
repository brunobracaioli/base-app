import * as z from 'zod';

const uuidV7Schema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

/** RFC 9457 fields used by the API plus explicitly typed response extensions. */
export const ProblemDetailsSchema = z.strictObject({
  type: z.string().min(1),
  title: z.string().min(1),
  status: z.number().int().min(100).max(599),
  code: z.string().regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/),
  requestId: uuidV7Schema,
  detail: z.string().min(1).optional(),
  instance: z.string().min(1).optional(),
  entitlement: z.string().min(1).optional(),
});

export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;
