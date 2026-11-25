import * as z from 'zod';

const hostSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes('://') && !/[/?#\s]/.test(value), {
    message: 'APP_HOST must be a host name without scheme or path.',
  });

const upstashUrlSchema = z.url().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}, 'UPSTASH_REDIS_REST_URL must be an HTTPS origin without embedded credentials or query.');

const databaseUrlSchema = z.url().refine((value) => {
  const sslOverrideParameters = new Set(['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert']);
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'postgres:' || url.protocol === 'postgresql:') &&
      url.hostname.length > 0 &&
      url.pathname.length > 1 &&
      !Array.from(url.searchParams.keys()).some((key) =>
        sslOverrideParameters.has(key.toLowerCase()),
      )
    );
  } catch {
    return false;
  }
}, 'DATABASE_URL must use PostgreSQL and must not override TLS through SSL query parameters.');

export const SERVER_ENV_SCHEMA = z
  .object({
    APP_HOST: hostSchema,
    NODE_ENV: z.enum(['development', 'test', 'production']).optional(),
    VERCEL_ENV: z.enum(['development', 'preview', 'production']).optional(),
    VERCEL_URL: hostSchema.optional(),
    VERCEL_BRANCH_URL: hostSchema.optional(),
    DATABASE_URL: databaseUrlSchema.optional(),
    DATABASE_CA_CERT: z.string().min(1).optional(),
    UPSTASH_REDIS_REST_URL: upstashUrlSchema.optional(),
    UPSTASH_REDIS_REST_TOKEN: z.string().min(1).optional(),
    RESEND_API_KEY: z.string().min(1).optional(),
    RESEND_FROM_EMAIL: z.email().optional(),
    SENTRY_DSN: z.url().optional(),
    AUDIT_SUBJECT_KEY: z.string().min(32).optional(),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  })
  .passthrough()
  .refine(
    (environment) =>
      (environment.UPSTASH_REDIS_REST_URL === undefined) ===
      (environment.UPSTASH_REDIS_REST_TOKEN === undefined),
    {
      message:
        'Both UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be configured together.',
      path: ['UPSTASH_REDIS_REST_TOKEN'],
    },
  )
  .refine(
    (environment) =>
      (environment.DATABASE_URL === undefined) === (environment.DATABASE_CA_CERT === undefined),
    {
      message: 'Both DATABASE_URL and DATABASE_CA_CERT must be configured together.',
      path: ['DATABASE_CA_CERT'],
    },
  );

export type ServerEnv = z.infer<typeof SERVER_ENV_SCHEMA>;

export type DatabaseEnvironment = {
  readonly DATABASE_URL: string;
  readonly DATABASE_CA_CERT: string;
};

export function parseServerEnv(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ServerEnv {
  return SERVER_ENV_SCHEMA.parse(environment);
}

export function validateRuntimeEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ServerEnv {
  const parsed = parseServerEnv(environment);
  if (
    (parsed.VERCEL_ENV === 'preview' || parsed.VERCEL_ENV === 'production') &&
    (!parsed.UPSTASH_REDIS_REST_URL || !parsed.UPSTASH_REDIS_REST_TOKEN)
  ) {
    throw new Error('Upstash Redis credentials are required for Vercel preview and production.');
  }
  if (
    (parsed.VERCEL_ENV === 'preview' || parsed.VERCEL_ENV === 'production') &&
    (!parsed.DATABASE_URL || !parsed.DATABASE_CA_CERT)
  ) {
    throw new Error(
      'Database URL and TLS CA certificate are required for Vercel preview and production.',
    );
  }
  return parsed;
}

export function requireDatabaseEnvironment(env: ServerEnv): DatabaseEnvironment {
  if (!env.DATABASE_URL || !env.DATABASE_CA_CERT) {
    throw new Error('DATABASE_URL and DATABASE_CA_CERT are not configured.');
  }
  return {
    DATABASE_URL: env.DATABASE_URL,
    DATABASE_CA_CERT: env.DATABASE_CA_CERT,
  };
}

export function requireAuditSubjectKey(env: ServerEnv): string {
  if (!env.AUDIT_SUBJECT_KEY) throw new Error('AUDIT_SUBJECT_KEY is not configured.');
  return env.AUDIT_SUBJECT_KEY;
}
