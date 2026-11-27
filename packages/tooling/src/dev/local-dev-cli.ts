import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateOrCheckSupabaseConfig } from '../guards/supabase-config.js';
import {
  EXCLUDED_SUPABASE_SERVICES,
  LOCAL_DOCKER_NETWORK,
  LOCAL_PORTS,
  LOCAL_PROJECT_ID,
  REDIS_HTTP_IMAGE,
  REDIS_IMAGE,
  buildLocalSupabaseConfig,
  generateLocalSecrets,
  generateLocalSigningKeys,
  isPrivateLanAddress,
  parseLocalSecrets,
  parseSupabaseStatus,
  pickLanAddress,
  publishedBindingsAreLoopback,
  routeGatewayRequest,
  stripUpstashOnlyScriptFlags,
  upsertManagedEnvBlock,
  type LocalSecrets,
  type SupabaseLocalStatus,
} from './local-stack.js';

/**
 * `pnpm dev`: local stack for one developer (see docs/how-to/local-dev-stack.md).
 *  - Supabase (Auth, Postgres, Mailpit) and Redis run in Docker; Redis is published on 127.0.0.1.
 *  - The Next.js API runs on 127.0.0.1:3000.
 *  - The phone reaches only a small gateway on the Wi-Fi address (public Auth endpoints + /api)
 *    and Metro (the Expo bundler).
 * Messages are in Portuguese because students read them; code stays in English.
 */

const isWindows = process.platform === 'win32';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const workDir = path.join(root, '.local-dev');
const supabaseWorkDir = path.join(workDir, 'supabase');
const secretsPath = path.join(workDir, 'secrets.json');
const dbContainer = `supabase_db_${LOCAL_PROJECT_ID}`;
const redisContainer = `${LOCAL_PROJECT_ID}-redis`;
const redisHttpContainer = `${LOCAL_PROJECT_ID}-redis-http`;

type RunResult = { readonly status: number; readonly stdout: string; readonly stderr: string };

function run(
  command: string,
  args: readonly string[],
  options: { readonly input?: string; readonly inherit?: boolean } = {},
): RunResult {
  const result = spawnSync(command, args, {
    cwd: root,
    input: options.input,
    encoding: 'utf8',
    stdio: options.inherit ? ['ignore', 'inherit', 'inherit'] : undefined,
    shell: isWindows && command.endsWith('.cmd'),
    env: process.env,
  });
  return {
    status: result.status ?? 1,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };
}

class StudentFacingError extends Error {}

function fail(message: string): never {
  throw new StudentFacingError(message);
}

function supabaseBinary(): string {
  const local = path.join(root, 'node_modules', '.bin', isWindows ? 'supabase.cmd' : 'supabase');
  return existsSync(local) ? local : 'supabase';
}

function supabase(args: readonly string[], inherit = false): RunResult {
  return run(supabaseBinary(), [...args, '--workdir', workDir], { inherit });
}

function preflight(): void {
  if (run('docker', ['info', '--format', '{{.ServerVersion}}']).status !== 0) {
    fail(
      'O Docker não está rodando. Abra o Docker Desktop, espere ele iniciar e rode `pnpm dev` de novo.',
    );
  }
  if (run(supabaseBinary(), ['--version']).status !== 0) {
    fail('Supabase CLI não encontrado. Rode `pnpm install` na raiz do projeto.');
  }
}

function syncDirectory(name: string, destination: string): void {
  const source = path.join(root, 'supabase', name);
  rmSync(destination, { recursive: true, force: true });
  if (existsSync(source)) cpSync(source, destination, { recursive: true });
}

function readOrCreateSecrets(): LocalSecrets {
  if (existsSync(secretsPath)) {
    const parsed = parseLocalSecrets(readFileSync(secretsPath, 'utf8'));
    if (parsed) return parsed;
  }
  const secrets = generateLocalSecrets();
  writeFileSync(secretsPath, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  return secrets;
}

async function prepareWorkDir(): Promise<LocalSecrets> {
  await generateOrCheckSupabaseConfig(root, 'generate');
  mkdirSync(supabaseWorkDir, { recursive: true });
  writeFileSync(
    path.join(supabaseWorkDir, 'config.toml'),
    buildLocalSupabaseConfig(readFileSync(path.join(root, 'supabase', 'config.toml'), 'utf8')),
  );
  for (const name of ['migrations', 'tests']) syncDirectory(name, path.join(supabaseWorkDir, name));
  // Template paths in config.toml are written both relative to the project and to supabase/.
  syncDirectory('templates', path.join(supabaseWorkDir, 'templates'));
  syncDirectory('templates', path.join(workDir, 'templates'));
  const signingKeys = path.join(supabaseWorkDir, 'signing_keys.json');
  if (!existsSync(signingKeys)) {
    writeFileSync(signingKeys, generateLocalSigningKeys(), { mode: 0o600 });
  }
  try {
    chmodSync(signingKeys, 0o600);
  } catch {
    // Windows has no POSIX modes; the file stays inside the git-ignored work directory.
  }
  return readOrCreateSecrets();
}

function ensureLoopbackNetwork(): void {
  if (run('docker', ['network', 'inspect', LOCAL_DOCKER_NETWORK]).status === 0) return;
  const created = run('docker', [
    'network',
    'create',
    '--driver',
    'bridge',
    '--opt',
    'com.docker.network.bridge.host_binding_ipv4=127.0.0.1',
    LOCAL_DOCKER_NETWORK,
  ]);
  if (created.status !== 0) fail('Não consegui criar a rede Docker local do projeto.');
}

/**
 * Docker Desktop publishes Supabase ports on every interface and the Supabase CLI has no bind
 * option. Studio stays off; tell the student what remains reachable on the Wi-Fi.
 */
function warnAboutNetworkExposure(): void {
  const listed = run('docker', [
    'ps',
    '--filter',
    `name=_${LOCAL_PROJECT_ID}`,
    '--format',
    '{{.Ports}}',
  ]);
  if (listed.status !== 0 || publishedBindingsAreLoopback(listed.stdout.split(/\r?\n/))) return;
  process.stdout.write(
    [
      '',
      '⚠ O Docker publicou as portas do Supabase local em todas as redes do computador.',
      '  Enquanto o `pnpm dev` roda, outra pessoa no mesmo Wi-Fi alcança o banco local (senha padrão',
      '  do Supabase), o login local e a caixa de e-mail local. Só há dados de desenvolvimento, mas use',
      '  a rede de casa ou o hotspot do seu celular; não use Wi-Fi público.',
      '',
    ].join('\n'),
  );
}

function startSupabase(): SupabaseLocalStatus {
  process.stdout.write(
    '\n▶ Subindo o Supabase local (a primeira vez baixa as imagens e demora)...\n',
  );
  const started = supabase(['start', '--exclude', EXCLUDED_SUPABASE_SERVICES.join(',')], true);
  if (started.status !== 0) {
    fail(
      'O Supabase local não subiu. Veja a mensagem acima. Se falar de porta em uso, feche outros ' +
        'projetos Supabase (`supabase stop --all`) e tente de novo.',
    );
  }
  warnAboutNetworkExposure();
  const migrated = supabase(['migration', 'up', '--local'], true);
  if (migrated.status !== 0) fail('Falha ao aplicar as migrations. Veja o erro acima.');
  const status = supabase(['status', '--output', 'json']);
  if (status.status !== 0) fail('Não consegui ler o status do Supabase local.');
  return parseSupabaseStatus(status.stdout);
}

function configureRuntimeRole(secrets: LocalSecrets): void {
  // The password is base64url (validated), so it is safe inside a SQL string literal.
  const sql = `ALTER ROLE api_runtime WITH LOGIN PASSWORD '${secrets.apiRuntimePassword}';\n`;
  const result = run(
    'docker',
    [
      'exec',
      '-i',
      dbContainer,
      'psql',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-q',
    ],
    { input: sql },
  );
  if (result.status !== 0) fail('Não consegui configurar o acesso da API ao banco local.');
}

function containerState(name: string): 'running' | 'stopped' | 'absent' {
  const inspected = run('docker', ['inspect', '--format', '{{.State.Running}}', name]);
  if (inspected.status !== 0) return 'absent';
  return inspected.stdout.trim() === 'true' ? 'running' : 'stopped';
}

function ensureContainer(name: string, runArgs: readonly string[]): void {
  const state = containerState(name);
  if (state === 'running') return;
  const result =
    state === 'stopped'
      ? run('docker', ['start', name])
      : run('docker', [
          'run',
          '--detach',
          '--name',
          name,
          '--network',
          LOCAL_DOCKER_NETWORK,
          ...runArgs,
        ]);
  if (result.status !== 0) fail(`Não consegui iniciar o container ${name}.`);
}

function removeIfPublishedElsewhere(name: string, expectedBinding: string): void {
  if (containerState(name) === 'absent') return;
  const ports = run('docker', ['port', name]);
  if (ports.status === 0 && ports.stdout.includes(expectedBinding)) return;
  run('docker', ['rm', '--force', name]);
}

function startRedis(secrets: LocalSecrets): void {
  ensureContainer(redisContainer, [
    REDIS_IMAGE,
    'redis-server',
    '--save',
    '',
    '--appendonly',
    'no',
  ]);
  const upstreamBinding = `127.0.0.1:${LOCAL_PORTS.redisHttpUpstream}`;
  removeIfPublishedElsewhere(redisHttpContainer, upstreamBinding);
  ensureContainer(redisHttpContainer, [
    '--publish',
    `${upstreamBinding}:80`,
    '--env',
    'SRH_MODE=env',
    '--env',
    `SRH_TOKEN=${secrets.redisToken}`,
    '--env',
    `SRH_CONNECTION_STRING=redis://${redisContainer}:6379`,
    REDIS_HTTP_IMAGE,
  ]);
}

function resolveLanAddress(): string {
  const override = process.env.LOCAL_DEV_HOST?.trim();
  if (override) {
    if (!isPrivateLanAddress(override)) {
      fail(
        'LOCAL_DEV_HOST precisa ser um IPv4 da rede local (192.168.x.x, 10.x.x.x ou 172.16-31.x.x).',
      );
    }
    return override;
  }
  const picked = pickLanAddress(networkInterfaces());
  if (!picked) {
    fail(
      'Não encontrei o IP da rede Wi-Fi. Conecte o computador ao mesmo Wi-Fi do celular ou defina ' +
        'LOCAL_DEV_HOST=<seu IP local> antes de `pnpm dev`.',
    );
  }
  return picked;
}

function updateEnvFile(file: string, values: Readonly<Record<string, string>>): void {
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  writeFileSync(file, upsertManagedEnvBlock(existing, values));
}

/** Writes both env files and returns the API variables, also passed to the API process directly. */
function writeEnvFiles(
  status: SupabaseLocalStatus,
  secrets: LocalSecrets,
  lan: string,
): Readonly<Record<string, string>> {
  const serverEnvironment = {
    APP_HOST: `localhost:${LOCAL_PORTS.web}`,
    SUPABASE_URL: `http://127.0.0.1:${LOCAL_PORTS.api}`,
    DATABASE_URL: `postgresql://api_runtime:${secrets.apiRuntimePassword}@127.0.0.1:${LOCAL_PORTS.db}/postgres`,
    UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${LOCAL_PORTS.redisHttp}`,
    UPSTASH_REDIS_REST_TOKEN: secrets.redisToken,
    AUDIT_SUBJECT_KEY: secrets.auditSubjectKey,
    LOG_LEVEL: 'warn',
  };
  updateEnvFile(path.join(root, '.env.local'), serverEnvironment);
  const gateway = `http://${lan}:${LOCAL_PORTS.gateway}`;
  updateEnvFile(path.join(root, 'apps', 'mobile', '.env.local'), {
    EXPO_PUBLIC_API_URL: `${gateway}/api`,
    EXPO_PUBLIC_SUPABASE_URL: gateway,
    EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: status.publishableKey,
  });
  return serverEnvironment;
}

const REDIS_PROXY_MAX_BODY_BYTES = 1_048_576;
const REDIS_PROXY_TIMEOUT_MS = 10_000;

/**
 * Loopback-only proxy between the API and the Redis HTTP bridge. It forwards the request as is
 * (the bridge still checks the bearer token) and only rewrites Upstash-only Lua script flags.
 */
function startRedisProxy(): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > REDIS_PROXY_MAX_BODY_BYTES) {
        response.writeHead(413).end();
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (response.writableEnded) return;
      const body = Buffer.from(stripUpstashOnlyScriptFlags(Buffer.concat(chunks).toString('utf8')));
      const headers = { ...request.headers, host: `127.0.0.1:${LOCAL_PORTS.redisHttpUpstream}` };
      headers['content-length'] = String(body.length);
      delete headers['transfer-encoding'];
      const upstream = http.request(
        {
          host: '127.0.0.1',
          port: LOCAL_PORTS.redisHttpUpstream,
          method: request.method,
          path: request.url,
          headers,
          timeout: REDIS_PROXY_TIMEOUT_MS,
        },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(response);
        },
      );
      upstream.on('timeout', () => upstream.destroy(new Error('upstream_timeout')));
      upstream.on('error', () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      upstream.end(body);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', () =>
      reject(
        new StudentFacingError(
          `A porta ${LOCAL_PORTS.redisHttp} está em uso. Feche o outro \`pnpm dev\` e tente de novo.`,
        ),
      ),
    );
    server.listen(LOCAL_PORTS.redisHttp, '127.0.0.1', () => resolve(server));
  });
}

const GATEWAY_TIMEOUT_MS = 30_000;

function startGateway(lan: string): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    const target = routeGatewayRequest(request.url ?? '');
    if (!target) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"error":"not_found"}');
      return;
    }
    const port = target === 'auth' ? LOCAL_PORTS.api : LOCAL_PORTS.web;
    const headers = { ...request.headers };
    headers.host = target === 'auth' ? `127.0.0.1:${port}` : `localhost:${port}`;
    delete headers['x-forwarded-host'];
    headers['x-forwarded-for'] = request.socket.remoteAddress ?? '';
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port,
        method: request.method,
        path: request.url,
        headers,
        timeout: GATEWAY_TIMEOUT_MS,
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on('timeout', () => upstream.destroy(new Error('upstream_timeout')));
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
      response.end('{"error":"local_service_unavailable"}');
    });
    request.pipe(upstream);
  });
  return new Promise((resolve, reject) => {
    server.once('error', () =>
      reject(
        new StudentFacingError(
          `A porta ${LOCAL_PORTS.gateway} está em uso em ${lan}. Feche o outro \`pnpm dev\` e tente de novo.`,
        ),
      ),
    );
    server.listen(LOCAL_PORTS.gateway, lan, () => resolve(server));
  });
}

const STOP_GRACE_MS = 5_000;

type ManagedChild = { readonly process: ChildProcess; readonly ownProcessGroup: boolean };

const children: ManagedChild[] = [];

/**
 * On POSIX the API runs in its own process group, so stopping it also stops pnpm's script shell,
 * the Next.js wrapper and next-server (otherwise next-server can outlive Ctrl+C and keep port
 * 3000). Metro stays in the terminal's group: it reads keys from the TTY and gets Ctrl+C directly.
 */
function spawnChild(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  options: { readonly ownProcessGroup?: boolean } = {},
): ChildProcess {
  const ownProcessGroup = !isWindows && options.ownProcessGroup === true;
  const child = spawn(isWindows ? 'pnpm.cmd' : 'pnpm', args, {
    cwd: root,
    stdio: ownProcessGroup ? ['ignore', 'inherit', 'inherit'] : 'inherit',
    env,
    shell: isWindows,
    detached: ownProcessGroup,
  });
  children.push({ process: child, ownProcessGroup });
  return child;
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function signalChild(entry: ManagedChild, signal: NodeJS.Signals): void {
  const pid = entry.process.pid;
  if (pid === undefined) return;
  try {
    // The group may outlive its leader (pnpm), so the group is signalled even after it exits.
    if (entry.ownProcessGroup) process.kill(-pid, signal);
    else if (!hasExited(entry.process)) entry.process.kill(signal);
  } catch {
    // Already gone.
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (hasExited(child)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function stopChildren(): Promise<void> {
  if (isWindows) {
    for (const { process: child } of children) {
      if (child.pid !== undefined && !hasExited(child)) {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      }
    }
    return;
  }
  for (const entry of children) signalChild(entry, entry.ownProcessGroup ? 'SIGTERM' : 'SIGINT');
  await Promise.all(children.map((entry) => waitForExit(entry.process, STOP_GRACE_MS)));
  for (const entry of children) signalChild(entry, 'SIGKILL');
}

function portIsFree(port: number, host?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen({ port, host, exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

/** Fails fast when an earlier run (or another app) still holds the API or Metro port. */
async function assertDevPortsFree(): Promise<void> {
  const ports = [
    { port: LOCAL_PORTS.web, host: '127.0.0.1', name: 'API' },
    { port: LOCAL_PORTS.metro, host: undefined, name: 'Metro' },
  ];
  for (const { port, host, name } of ports) {
    if (!(await portIsFree(port, host))) {
      fail(
        `A porta ${port} (${name}) já está em uso. Provavelmente um \`pnpm dev\` anterior ainda está ` +
          'aberto: feche aquele terminal (ou finalize o processo que usa a porta) e rode `pnpm dev` de novo.',
      );
    }
  }
}

async function waitForApi(web: ChildProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !hasExited(web)) {
    const ok = await new Promise<boolean>((resolve) => {
      const probe = http.get(
        {
          host: '127.0.0.1',
          port: LOCAL_PORTS.web,
          path: '/api/v1/health',
          headers: { host: `localhost:${LOCAL_PORTS.web}` },
          timeout: 3_000,
        },
        (response) => {
          response.resume();
          resolve(response.statusCode === 200);
        },
      );
      probe.on('error', () => resolve(false));
      probe.on('timeout', () => probe.destroy());
    });
    if (ok) return !hasExited(web);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

/**
 * Expo Go on a physical iPhone opens a development server only when Expo CLI and Expo Go are signed
 * in to the same (free) Expo account. Android, simulators and published updates are not affected.
 * Returns the account name, or null when Expo CLI is not signed in.
 */
function expoAccount(): string | null {
  const binary = path.join(
    root,
    'apps',
    'mobile',
    'node_modules',
    '.bin',
    isWindows ? 'expo.cmd' : 'expo',
  );
  if (!existsSync(binary)) return null;
  const result = run(binary, ['whoami']);
  const account = result.stdout.trim().split(/\r?\n/).pop()?.trim() ?? '';
  return result.status === 0 && /^[A-Za-z0-9._-]{1,64}$/.test(account) ? account : null;
}

function printSummary(status: SupabaseLocalStatus, lan: string, account: string | null): void {
  const mail = status.mailUrl ?? `http://127.0.0.1:${LOCAL_PORTS.mail}`;
  process.stdout.write(
    [
      '',
      '──────────────────────────────────────────────────────────────',
      ' Ambiente local pronto',
      `  E-mails com os códigos de login: ${mail}`,
      `  Banco de dados: postgresql://postgres:postgres@127.0.0.1:${LOCAL_PORTS.db}/postgres`,
      `  API: http://localhost:${LOCAL_PORTS.web}/api/v1/health`,
      `  O celular acessa: http://${lan}:${LOCAL_PORTS.gateway} (só login e /api)`,
      '',
      ' Agora: abra o Expo Go no celular (mesmo Wi-Fi) e leia o QR code abaixo.',
      account
        ? `  iPhone: entre no Expo Go com a conta Expo "${account}" (a mesma do computador).`
        : '  iPhone: o Expo Go exige login numa conta Expo (grátis). Em outro terminal rode\n' +
          '  `pnpm expo:login` e entre no Expo Go com a mesma conta. Android não precisa.',
      ' Para parar: Ctrl+C. Para desligar o banco: pnpm dev:stop',
      '──────────────────────────────────────────────────────────────',
      '',
    ].join('\n'),
  );
}

async function up(): Promise<void> {
  preflight();
  await assertDevPortsFree();
  const secrets = await prepareWorkDir();
  const status = startSupabase();
  ensureLoopbackNetwork();
  configureRuntimeRole(secrets);
  startRedis(secrets);
  const lan = resolveLanAddress();
  const serverEnvironment = writeEnvFiles(status, secrets, lan);
  const redisProxy = await startRedisProxy();
  const gateway = await startGateway(lan);

  let stopping = false;
  const shutdown = async (exitCode: number): Promise<void> => {
    if (stopping) return;
    stopping = true;
    gateway.close();
    redisProxy.close();
    await stopChildren();
    process.exit(exitCode);
  };
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));

  process.stdout.write('\n▶ Iniciando a API (Next.js)...\n');
  // Passed explicitly: the API's own .env.local loader skips the file when CI is set.
  const web = spawnChild(
    ['--filter', 'web', 'dev'],
    { ...process.env, ...serverEnvironment },
    { ownProcessGroup: true },
  );
  web.on('exit', (code) => {
    if (stopping) return;
    process.stderr.write('\nA API parou. Veja o erro acima.\n');
    void shutdown(code === 0 ? 0 : 1);
  });
  if (!(await waitForApi(web, 180_000))) {
    if (stopping) return;
    process.stderr.write('\nA API não respondeu em 3 minutos. Veja o erro acima.\n');
    await shutdown(1);
    return;
  }

  printSummary(status, lan, expoAccount());
  const metro = spawnChild(['--filter', 'mobile', 'start'], {
    ...process.env,
    REACT_NATIVE_PACKAGER_HOSTNAME: lan,
    // expo-dev-client is installed, so Expo CLI would encode an interstitial web page in the QR code
    // (`/_expo/loading`), which the iPhone camera opens in Safari. Expo Go needs the exp:// URL.
    EXPO_NO_REDIRECT_PAGE: '1',
  });
  metro.on('exit', () => void shutdown(0));
}

async function stop(): Promise<void> {
  supabase(['stop'], true);
  for (const name of [redisHttpContainer, redisContainer]) {
    if (containerState(name) === 'running') run('docker', ['stop', name]);
  }
  process.stdout.write('Ambiente local desligado. Os dados do banco continuam salvos.\n');
}

async function resetDatabase(): Promise<void> {
  preflight();
  const secrets = await prepareWorkDir();
  const reset = supabase(['db', 'reset', '--local'], true);
  if (reset.status !== 0)
    fail('Falha ao recriar o banco local. Rode `pnpm dev` antes, se ele estiver desligado.');
  configureRuntimeRole(secrets);
  process.stdout.write('Banco local recriado com todas as migrations.\n');
}

const commands: Record<string, () => Promise<void>> = {
  up,
  stop,
  'db-reset': resetDatabase,
};

const command = commands[process.argv[2] ?? 'up'];
if (!command) {
  process.stderr.write('Uso: local-dev-cli <up|stop|db-reset>\n');
  process.exitCode = 2;
} else {
  command().catch(async (error: unknown) => {
    await stopChildren();
    const message =
      error instanceof StudentFacingError
        ? error.message
        : 'O ambiente local falhou. Veja o erro acima.';
    process.stderr.write(`\n✖ ${message}\n`);
    process.exitCode = 1;
  });
}
