import { createHash, X509Certificate } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export type AppConfigDatabaseTarget = Readonly<{
  host: string;
  port: number;
  database: string;
  username: string;
  caSha256: string;
}>;

export type AppConfigDatabaseConnection = Readonly<{
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}>;

export type AppConfigOperatorEnvironment = Readonly<{
  database: AppConfigDatabaseConnection;
  databaseCaCertificate: string;
  target: AppConfigDatabaseTarget;
  trustFile: string;
  signingKeyFile?: string;
}>;

export type AppConfigSigningEnvironment = Readonly<{
  trustFile: string;
  signingKeyFile: string;
}>;

export class AppConfigOperatorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AppConfigOperatorError';
    this.code = code;
  }
}

function requiredEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value)
    throw new AppConfigOperatorError('app_config.operator_environment', `${name} is required.`);
  return value;
}

function isInsideDirectory(directory: string, candidate: string): boolean {
  const pathFromDirectory = relative(directory, candidate);
  return (
    pathFromDirectory === '' ||
    (!pathFromDirectory.startsWith(`..${sep}`) &&
      pathFromDirectory !== '..' &&
      !isAbsolute(pathFromDirectory))
  );
}

export function assertOutsideCheckout(candidate: string, checkoutRoot: string): string {
  if (!isAbsolute(candidate)) {
    throw new AppConfigOperatorError(
      'app_config.unsafe_path',
      'Approval files must use absolute paths outside the checkout.',
    );
  }
  const normalizedCandidate = resolve(candidate);
  const normalizedRoot = resolve(checkoutRoot);
  if (isInsideDirectory(normalizedRoot, normalizedCandidate)) {
    throw new AppConfigOperatorError(
      'app_config.unsafe_path',
      'Approval files must be stored outside the checkout.',
    );
  }
  return normalizedCandidate;
}

function parseAppConfigDatabase(
  databaseUrl: string,
  caCertificate: string,
): { readonly target: AppConfigDatabaseTarget; readonly connection: AppConfigDatabaseConnection } {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new AppConfigOperatorError(
      'app_config.operator_environment',
      'The admin database URL is invalid.',
    );
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hostname.length === 0 ||
    url.username.length === 0 ||
    url.password.length === 0 ||
    url.pathname.length <= 1 ||
    url.hash.length > 0
  ) {
    throw new AppConfigOperatorError(
      'app_config.operator_environment',
      'The admin database URL must identify a dedicated PostgreSQL login and database.',
    );
  }
  let username: string;
  let password: string;
  let database: string;
  try {
    username = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
    database = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new AppConfigOperatorError(
      'app_config.operator_environment',
      'The admin database URL is invalid.',
    );
  }
  if (username === 'postgres') {
    throw new AppConfigOperatorError(
      'app_config.operator_environment',
      'The app-config CLI requires a dedicated login; the postgres role is not allowed.',
    );
  }
  if (url.search.length > 0 || databaseUrl.includes('?')) {
    throw new AppConfigOperatorError(
      'app_config.ssl_override',
      'Database URL query parameters are not allowed; provide TLS settings through the app-config CA variable.',
    );
  }
  const normalizedCa = caCertificate.trim();
  if (normalizedCa.length === 0) {
    throw new AppConfigOperatorError(
      'app_config.operator_environment',
      'The app-config admin database CA certificate is required.',
    );
  }
  try {
    new X509Certificate(normalizedCa);
  } catch {
    throw new AppConfigOperatorError(
      'app_config.operator_environment',
      'The app-config admin database CA certificate is invalid.',
    );
  }
  const port = url.port.length > 0 ? Number(url.port) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new AppConfigOperatorError(
      'app_config.operator_environment',
      'The admin database port is invalid.',
    );
  }
  const host = url.hostname.toLowerCase();
  const caSha256 = createHash('sha256').update(normalizedCa).digest('hex');
  return Object.freeze({
    target: Object.freeze({ host, port, database, username, caSha256 }),
    connection: Object.freeze({ host, port, database, user: username, password }),
  });
}

export function parseAppConfigDatabaseTarget(
  databaseUrl: string,
  caCertificate: string,
): AppConfigDatabaseTarget {
  return parseAppConfigDatabase(databaseUrl, caCertificate).target;
}

export function loadAppConfigOperatorEnvironment(
  environment: NodeJS.ProcessEnv,
  checkoutRoot: string,
  options: { readonly requireSigningKey?: boolean } = {},
): AppConfigOperatorEnvironment {
  const databaseUrl = requiredEnvironmentValue(environment, 'APP_CONFIG_ADMIN_DATABASE_URL');
  const databaseCaCertificate = requiredEnvironmentValue(
    environment,
    'APP_CONFIG_ADMIN_DATABASE_CA_CERT',
  );
  const trustFile = assertOutsideCheckout(
    requiredEnvironmentValue(environment, 'APP_CONFIG_TRUST_FILE'),
    checkoutRoot,
  );
  const rawSigningKey = environment.APP_CONFIG_SIGNING_KEY_FILE?.trim();
  if (options.requireSigningKey && !rawSigningKey) {
    throw new AppConfigOperatorError(
      'app_config.operator_environment',
      'APP_CONFIG_SIGNING_KEY_FILE is required for signing.',
    );
  }
  const signingKeyFile = rawSigningKey
    ? assertOutsideCheckout(rawSigningKey, checkoutRoot)
    : undefined;
  const parsedDatabase = parseAppConfigDatabase(databaseUrl, databaseCaCertificate);
  return Object.freeze({
    database: parsedDatabase.connection,
    databaseCaCertificate,
    target: parsedDatabase.target,
    trustFile,
    ...(signingKeyFile === undefined ? {} : { signingKeyFile }),
  });
}

export function loadAppConfigSigningEnvironment(
  environment: NodeJS.ProcessEnv,
  checkoutRoot: string,
): AppConfigSigningEnvironment {
  return Object.freeze({
    trustFile: assertOutsideCheckout(
      requiredEnvironmentValue(environment, 'APP_CONFIG_TRUST_FILE'),
      checkoutRoot,
    ),
    signingKeyFile: assertOutsideCheckout(
      requiredEnvironmentValue(environment, 'APP_CONFIG_SIGNING_KEY_FILE'),
      checkoutRoot,
    ),
  });
}

export function defaultPlanDirectory(environment: NodeJS.ProcessEnv): string {
  const stateRoot = environment.XDG_STATE_HOME?.trim();
  if (stateRoot) {
    if (!isAbsolute(stateRoot)) {
      throw new AppConfigOperatorError(
        'app_config.unsafe_path',
        'XDG_STATE_HOME must be an absolute path.',
      );
    }
    return resolve(stateRoot, 'base-app', 'app-config', 'plans');
  }
  return resolve(homedir(), '.local', 'state', 'base-app', 'app-config', 'plans');
}
