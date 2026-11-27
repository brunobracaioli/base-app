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
    return (
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && isLoopbackHostname(url.hostname))) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}, 'UPSTASH_REDIS_REST_URL must be an HTTPS origin (or a loopback HTTP origin in development) without embedded credentials or query.');

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true;
  if (normalized === '::1') return true;
  const ipv4 = normalized.split('.');
  return (
    ipv4.length === 4 &&
    ipv4[0] === '127' &&
    ipv4.every((octet) => /^(?:0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255)
  );
}

const supabaseUrlSchema = z.url().refine((value) => {
  try {
    const url = new URL(value);
    const originOnly =
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.pathname === '' || url.pathname === '/');
    return (
      originOnly &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHostname(url.hostname)))
    );
  } catch {
    return false;
  }
}, 'SUPABASE_URL must be an HTTPS origin or a loopback HTTP origin in development/test.');

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
    SUPABASE_URL: supabaseUrlSchema.optional(),
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
      environment.DATABASE_CA_CERT === undefined || environment.DATABASE_URL !== undefined,
    {
      message: 'Both DATABASE_URL and DATABASE_CA_CERT must be configured together.',
      path: ['DATABASE_CA_CERT'],
    },
  )
  .superRefine((environment, context) => {
    const localRuntime = isLocalRuntime(environment);

    if (
      environment.DATABASE_URL !== undefined &&
      environment.DATABASE_CA_CERT === undefined &&
      !(localRuntime && isLoopbackUrl(environment.DATABASE_URL))
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Both DATABASE_URL and DATABASE_CA_CERT must be configured together; only a loopback database in development or test may omit the CA.',
        path: ['DATABASE_CA_CERT'],
      });
    }

    for (const key of ['SUPABASE_URL', 'UPSTASH_REDIS_REST_URL'] as const) {
      const value = environment[key];
      if (!value || localRuntime) continue;
      let protocol: string;
      try {
        protocol = new URL(value).protocol;
      } catch {
        continue;
      }
      if (protocol === 'http:') {
        context.addIssue({
          code: 'custom',
          message: `${key} may use HTTP only in development or test.`,
          path: [key],
        });
      }
    }
  });

/**
 * Local runtime = `next dev`/tests on the developer machine. Vercel preview and production are
 * never local, whatever NODE_ENV says.
 */
function isLocalRuntime(environment: {
  readonly NODE_ENV?: string | undefined;
  readonly VERCEL_ENV?: string | undefined;
}): boolean {
  if (environment.VERCEL_ENV === 'preview' || environment.VERCEL_ENV === 'production') return false;
  return (
    environment.VERCEL_ENV === 'development' ||
    environment.NODE_ENV === 'development' ||
    environment.NODE_ENV === 'test'
  );
}

function isLoopbackUrl(value: string): boolean {
  try {
    return isLoopbackHostname(new URL(value).hostname);
  } catch {
    return false;
  }
}

export type ServerEnv = z.infer<typeof SERVER_ENV_SCHEMA>;

/**
 * `DATABASE_CA_CERT: null` exists only for the local development stack: a loopback database in
 * development/test, reached without TLS. Every other database connection requires the CA.
 */
export type DatabaseEnvironment = {
  readonly DATABASE_URL: string;
  readonly DATABASE_CA_CERT: string | null;
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
  if (
    (parsed.VERCEL_ENV === 'preview' || parsed.VERCEL_ENV === 'production') &&
    !parsed.SUPABASE_URL
  ) {
    throw new Error('SUPABASE_URL is required for Vercel preview and production.');
  }
  return parsed;
}

export function requireDatabaseEnvironment(env: ServerEnv): DatabaseEnvironment {
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL and DATABASE_CA_CERT are not configured.');
  }
  if (env.DATABASE_CA_CERT) {
    return { DATABASE_URL: env.DATABASE_URL, DATABASE_CA_CERT: env.DATABASE_CA_CERT };
  }
  if (isLocalRuntime(env) && isLoopbackUrl(env.DATABASE_URL)) {
    return { DATABASE_URL: env.DATABASE_URL, DATABASE_CA_CERT: null };
  }
  throw new Error('DATABASE_URL and DATABASE_CA_CERT are not configured.');
}

export function requireAuditSubjectKey(env: ServerEnv): string {
  if (!env.AUDIT_SUBJECT_KEY) throw new Error('AUDIT_SUBJECT_KEY is not configured.');
  return env.AUDIT_SUBJECT_KEY;
}
