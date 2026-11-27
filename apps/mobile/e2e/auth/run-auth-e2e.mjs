import { appendFile, mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const authDirectory = path.dirname(fileURLToPath(import.meta.url));
const nativeDirectory = path.resolve(
  authDirectory,
  '../../../../../../.artifacts/recovery/w6/native',
);
const runDirectory = path.join(nativeDirectory, 'maestro-run', `${Date.now()}-${process.pid}`);
const logPath = path.join(nativeDirectory, 'maestro-run.log');

const scenarios = {
  'login-email-code': {
    startFlow: 'login-email-code.start.yaml',
    finishFlow: 'login-email-code.finish.yaml',
    emailVariable: 'MAESTRO_AUTH_EMAIL',
  },
  'signup-email-password': {
    startFlow: 'signup-email-password.start.yaml',
    finishFlow: 'signup-email-password.finish.yaml',
    emailVariable: 'MAESTRO_SIGNUP_EMAIL',
  },
  'password-recovery': {
    startFlow: 'password-recovery.start.yaml',
    finishFlow: 'password-recovery.finish.yaml',
    emailVariable: 'MAESTRO_RECOVERY_EMAIL',
  },
  'change-password': {
    startFlow: 'change-password.start.yaml',
    finishFlow: 'change-password.finish.yaml',
    emailVariable: 'MAESTRO_LOGIN_EMAIL',
  },
};

function requireInput(name) {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required test input: ${name}`);
  }
  return value;
}

function appendDiagnostic(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  return appendFile(logPath, line, { mode: 0o600 });
}

async function runMaestro(flowPath, appId, artifactsPath, includeOtp) {
  const environment = { ...process.env };
  delete environment.MAESTRO_AUTH_OTP;
  delete environment.MAESTRO_MAILPIT_BASE_URL;
  delete environment.MAESTRO_MAILPIT_USERNAME;
  delete environment.MAESTRO_MAILPIT_PASSWORD;
  delete environment.MAESTRO_NATIVE_ARTIFACTS;

  if (includeOtp) {
    environment.MAESTRO_AUTH_OTP = includeOtp;
  }

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.MAESTRO_BIN ?? 'maestro',
      [
        'test',
        `--test-output-dir=${artifactsPath}`,
        '--format=NOOP',
        '-e',
        `APP_ID=${appId}`,
        flowPath,
      ],
      { cwd: authDirectory, env: environment, stdio: 'ignore' },
    );

    child.once('error', () => reject(new Error('Maestro could not start.')));
    child.once('close', (code) => resolve(code ?? 1));
  });
}

function mailpitBaseUrl() {
  const base = new URL(requireInput('MAESTRO_MAILPIT_BASE_URL'));
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new Error('Mailpit URL must use HTTP or HTTPS.');
  }
  if (base.username.length > 0 || base.password.length > 0) {
    throw new Error('Use separate Mailpit credentials instead of credentials in the URL.');
  }
  base.pathname = base.pathname.replace(/\/$/, '');
  base.search = '';
  base.hash = '';
  return base;
}

async function fetchJson(url, headers) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('Mailpit API request failed.');
  return response.json();
}

function mailpitHeaders() {
  const username = process.env.MAESTRO_MAILPIT_USERNAME;
  const password = process.env.MAESTRO_MAILPIT_PASSWORD;
  if (username === undefined && password === undefined) return {};
  if (username === undefined || password === undefined) {
    throw new Error('Both Mailpit credentials must be supplied together.');
  }
  return { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
}

async function readRecentOtp({ email, sentAfter }) {
  const base = mailpitBaseUrl();
  const headers = mailpitHeaders();
  const deadline = Date.now() + 60_000;
  const searchUrl = new URL(`${base.toString().replace(/\/$/, '')}/api/v1/search`);
  searchUrl.searchParams.set('query', `to:"${email}"`);
  searchUrl.searchParams.set('limit', '20');

  while (Date.now() < deadline) {
    const search = await fetchJson(searchUrl, headers);
    const messages = Array.isArray(search.messages) ? search.messages : [];
    const recent = messages.find((message) => {
      const created = Date.parse(String(message.Created ?? ''));
      const recipients = Array.isArray(message.To) ? message.To : [];
      const hasRecipient = recipients.some(
        (recipient) => String(recipient.Address ?? '').toLowerCase() === email.toLowerCase(),
      );
      return Number.isFinite(created) && created >= sentAfter && hasRecipient;
    });

    if (recent !== undefined && typeof recent.ID === 'string') {
      const messageUrl = new URL(
        `${base.toString().replace(/\/$/, '')}/api/v1/message/${encodeURIComponent(recent.ID)}`,
      );
      const message = await fetchJson(messageUrl, headers);
      const match = String(message.Text ?? '').match(/(?:^|\D)(\d{10})(?:\D|$)/);
      if (match?.[1] !== undefined) return match[1];
    }
    await delay(1000);
  }

  throw new Error('No fresh ten-digit verification code arrived in Mailpit.');
}

async function main() {
  const scenario = process.argv[2];
  const definition = scenarios[scenario];
  if (definition === undefined) {
    throw new Error(`Unknown auth scenario: ${String(scenario)}`);
  }

  const appId = requireInput('MAESTRO_APP_ID');
  const email = requireInput(definition.emailVariable);
  const sentAfter = Date.now();
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 });
  await appendDiagnostic(`scenario=${scenario} phase=start status=running`);

  try {
    const startStatus = await runMaestro(
      path.join(authDirectory, definition.startFlow),
      appId,
      path.join(runDirectory, 'start'),
    );
    await appendDiagnostic(`scenario=${scenario} phase=start status=${startStatus}`);
    if (startStatus !== 0)
      throw new Error('Maestro start phase failed; sensitive output was suppressed.');

    const otp = await readRecentOtp({ email, sentAfter });
    await appendDiagnostic(`scenario=${scenario} phase=mailpit status=fresh-code-received`);

    const finishStatus = await runMaestro(
      path.join(authDirectory, definition.finishFlow),
      appId,
      path.join(runDirectory, 'finish'),
      otp,
    );
    await appendDiagnostic(`scenario=${scenario} phase=finish status=${finishStatus}`);
    if (finishStatus !== 0)
      throw new Error('Maestro finish phase failed; sensitive output was suppressed.');

    process.stdout.write(`Auth scenario passed: ${scenario}\n`);
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : 'Auth scenario failed.';
  await appendDiagnostic(`status=failed reason=${message.replace(/[\r\n]/g, ' ')}`).catch(
    () => undefined,
  );
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
