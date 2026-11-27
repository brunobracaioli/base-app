import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const supabaseBin = process.env.SUPABASE_CLI || 'supabase';
const expectedApiUrl = 'http://127.0.0.1:54721';
const mailpitUrl = process.env.W6_MAILPIT_URL || 'http://127.0.0.1:54724';
const suite = process.argv[2] ?? 'sau1';

const result = {
  suite,
  targetValidated: false,
  localStatusRead: false,
  fixtureCount: 0,
  cleanupCount: 0,
  cleanupComplete: false,
  messageCount: 0,
  messageCleanupCount: 0,
  messageCleanupComplete: false,
  measurementComplete: false,
  safeErrorCode: null,
};

let apiUrl;
let anonymousKey;
let serviceRoleKey;
const fixtureIds = new Set();
const mailpitMessageIds = new Set();

class ProbeError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function assertLoopbackTarget(value, expected, code) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ProbeError(code);
  }
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== '127.0.0.1' ||
    parsed.port !== new URL(expected).port ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    value.replace(/\/$/, '') !== expected
  ) {
    throw new ProbeError(code);
  }
  return value.replace(/\/$/, '');
}

function loadLocalStatus() {
  const cli = spawnSync(supabaseBin, ['status', '--workdir', repositoryRoot, '--output', 'json'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1' },
  });
  if (cli.status !== 0 || cli.error) throw new ProbeError('status');

  let status;
  try {
    status = JSON.parse(cli.stdout);
  } catch {
    throw new ProbeError('status_json');
  }
  const rawApiUrl = status.API_URL || status.api_url;
  const anon = status.ANON_KEY || status.anon_key;
  const service = status.SERVICE_ROLE_KEY || status.service_role_key;
  if (typeof rawApiUrl !== 'string' || typeof anon !== 'string' || typeof service !== 'string')
    throw new ProbeError('status_shape');

  apiUrl = assertLoopbackTarget(rawApiUrl, expectedApiUrl, 'api_target');
  assertLoopbackTarget(mailpitUrl, 'http://127.0.0.1:54724', 'mailpit_target');
  anonymousKey = anon;
  serviceRoleKey = service;
  result.localStatusRead = true;
  result.targetValidated = true;
}

async function request(url, { method = 'GET', apiKey, bearer, body } = {}) {
  const headers = { accept: 'application/json' };
  if (apiKey) headers.apikey = apiKey;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers['content-type'] = 'application/json';

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    });
  } catch {
    throw new ProbeError('request');
  }

  let payload = null;
  if ((response.headers.get('content-type') ?? '').includes('application/json')) {
    try {
      payload = await response.json();
    } catch {
      throw new ProbeError('response_json');
    }
  }
  return { ok: response.ok, status: response.status, payload };
}

function newCredentials() {
  return {
    email: `${randomBytes(18).toString('hex')}@example.invalid`,
    password: `A${randomBytes(32).toString('hex')}9z`,
  };
}

function assertAccepted(response, code) {
  if (response.status === 429) throw new ProbeError('rate_limited');
  if (!response.ok) throw new ProbeError(code);
}

async function adminCreateUser({ email, password, locale }) {
  const response = await request(`${apiUrl}/auth/v1/admin/users`, {
    method: 'POST',
    apiKey: serviceRoleKey,
    bearer: serviceRoleKey,
    body: {
      email,
      email_confirm: true,
      user_metadata: locale === undefined ? {} : { locale },
    },
  });
  assertAccepted(response, 'fixture_create');
  if (typeof response.payload?.id !== 'string') throw new ProbeError('fixture_create');
  const userId = response.payload.id;
  fixtureIds.add(userId);
  result.fixtureCount += 1;
  const passwordResponse = await request(
    `${apiUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
    {
      method: 'PUT',
      apiKey: serviceRoleKey,
      bearer: serviceRoleKey,
      body: { password },
    },
  );
  assertAccepted(passwordResponse, 'fixture_password_set');
  return { email, userId, password };
}

async function publicSignUp({ locale }) {
  const fixture = newCredentials();
  const response = await request(`${apiUrl}/auth/v1/signup`, {
    method: 'POST',
    apiKey: anonymousKey,
    bearer: anonymousKey,
    body: { ...fixture, data: { locale } },
  });
  const userId = response.payload?.id ?? response.payload?.user?.id;
  assertAccepted(response, 'signup_send');
  if (typeof userId !== 'string') throw new ProbeError('signup_send');
  fixtureIds.add(userId);
  result.fixtureCount += 1;
  return { ...fixture, userId };
}

async function findFixtureUserId(email) {
  const url = new URL(`${apiUrl}/auth/v1/admin/users`);
  url.searchParams.set('page', '1');
  url.searchParams.set('per_page', '1000');
  url.searchParams.set('filter', email);
  const response = await request(url.href, {
    apiKey: serviceRoleKey,
    bearer: serviceRoleKey,
  });
  assertAccepted(response, 'fixture_lookup');
  const users = response.payload?.users;
  const user = Array.isArray(users) ? users.find((item) => item?.email === email) : null;
  if (typeof user?.id !== 'string') throw new ProbeError('fixture_lookup');
  fixtureIds.add(user.id);
  result.fixtureCount += 1;
  return user.id;
}

async function passwordSignIn(fixture) {
  const response = await request(`${apiUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    apiKey: anonymousKey,
    bearer: anonymousKey,
    body: { email: fixture.email, password: fixture.password },
  });
  assertAccepted(response, 'sign_in');
  if (typeof response.payload?.access_token !== 'string') throw new ProbeError('sign_in');
  return response.payload.access_token;
}

function recipientsInclude(message, email) {
  const values = [];
  for (const key of ['To', 'to', 'Recipients', 'recipients']) {
    const recipients = message?.[key];
    if (typeof recipients === 'string') values.push(recipients);
    if (Array.isArray(recipients)) {
      for (const recipient of recipients) {
        if (typeof recipient === 'string') values.push(recipient);
        else if (recipient && typeof recipient === 'object') {
          values.push(recipient.Address, recipient.address, recipient.Email, recipient.email);
        }
      }
    }
  }
  return values.some((value) => typeof value === 'string' && value.toLowerCase().includes(email));
}

async function listMessages() {
  const response = await request(`${mailpitUrl}/api/v1/messages?start=0&limit=200`);
  assertAccepted(response, 'mailpit_list');
  if (!response.ok || !Array.isArray(response.payload?.messages))
    throw new ProbeError('mailpit_list');
  return response.payload.messages;
}

async function messageSnapshot() {
  const messages = await listMessages();
  return new Set(messages.map((message) => message?.ID ?? message?.Id ?? message?.id));
}

async function waitForMessage(email, previousIds, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const messages = await listMessages();
    const match = messages.find((message) => {
      const id = message?.ID ?? message?.Id ?? message?.id;
      return typeof id === 'string' && !previousIds.has(id) && recipientsInclude(message, email);
    });
    if (match) {
      const id = match.ID ?? match.Id ?? match.id;
      mailpitMessageIds.add(id);
      result.messageCount = mailpitMessageIds.size;
      const detail = await request(`${mailpitUrl}/api/v1/message/${encodeURIComponent(id)}`);
      assertAccepted(detail, 'mailpit_message');
      if (!detail.ok || !detail.payload || typeof detail.payload !== 'object')
        throw new ProbeError('mailpit_message');
      return detail.payload;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new ProbeError('mailpit_timeout');
}

async function waitForOtpMessage(email, previousIds, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const messages = await listMessages();
    const candidates = messages.filter((message) => {
      const id = message?.ID ?? message?.Id ?? message?.id;
      return (
        typeof id === 'string' &&
        !previousIds.has(id) &&
        !mailpitMessageIds.has(id) &&
        recipientsInclude(message, email)
      );
    });
    for (const candidate of candidates) {
      const id = candidate.ID ?? candidate.Id ?? candidate.id;
      const detail = await request(`${mailpitUrl}/api/v1/message/${encodeURIComponent(id)}`);
      assertAccepted(detail, 'mailpit_message');
      if (!detail.ok || !detail.payload || typeof detail.payload !== 'object')
        throw new ProbeError('mailpit_message');
      mailpitMessageIds.add(id);
      result.messageCount = mailpitMessageIds.size;
      if (/\b\d{6,10}\b/.test(messageText(detail.payload))) return detail.payload;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new ProbeError('mailpit_timeout');
}

async function waitForMatchingMessage(email, previousIds, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  const inspectedIds = new Set();
  while (Date.now() < deadline) {
    const messages = await listMessages();
    const candidates = messages.filter((message) => {
      const id = message?.ID ?? message?.Id ?? message?.id;
      return (
        typeof id === 'string' &&
        !previousIds.has(id) &&
        !inspectedIds.has(id) &&
        recipientsInclude(message, email)
      );
    });
    for (const candidate of candidates) {
      const id = candidate.ID ?? candidate.Id ?? candidate.id;
      inspectedIds.add(id);
      const detail = await request(`${mailpitUrl}/api/v1/message/${encodeURIComponent(id)}`);
      assertAccepted(detail, 'mailpit_message');
      if (!detail.ok || !detail.payload || typeof detail.payload !== 'object')
        throw new ProbeError('mailpit_message');
      mailpitMessageIds.add(id);
      result.messageCount = mailpitMessageIds.size;
      if (predicate(detail.payload)) return detail.payload;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new ProbeError('mailpit_timeout');
}

async function waitForOptionalMessage(email, previousIds, timeoutMs = 2_000) {
  try {
    return await waitForMessage(email, previousIds, timeoutMs);
  } catch (error) {
    if (error instanceof ProbeError && error.code === 'mailpit_timeout') return null;
    throw error;
  }
}

async function waitForOptionalMatchingMessage(email, previousIds, predicate, timeoutMs = 10_000) {
  try {
    return await waitForMatchingMessage(email, previousIds, predicate, timeoutMs);
  } catch (error) {
    if (error instanceof ProbeError && error.code === 'mailpit_timeout') return null;
    throw error;
  }
}

function messageText(message) {
  const candidates = [message.HTML, message.html, message.Text, message.text, message.TextBody];
  return candidates.filter((value) => typeof value === 'string').join('\n');
}

function messageSubject(message) {
  const headers = message.Headers ?? message.headers;
  const headerSubject = headers?.Subject ?? headers?.subject;
  const candidate = message.Subject ?? message.subject ?? headerSubject;
  return Array.isArray(candidate)
    ? candidate.filter((value) => typeof value === 'string').join(' ')
    : typeof candidate === 'string'
      ? candidate
      : '';
}

async function sendMagicLink(email, previousIds) {
  const response = await request(`${apiUrl}/auth/v1/otp`, {
    method: 'POST',
    apiKey: anonymousKey,
    bearer: anonymousKey,
    body: {
      email,
      create_user: false,
    },
  });
  assertAccepted(response, 'otp_send');
  const message = await waitForMessage(email, previousIds);
  return message;
}

async function sendOtpForSignup(email, locale, previousIds) {
  const response = await request(`${apiUrl}/auth/v1/otp`, {
    method: 'POST',
    apiKey: anonymousKey,
    bearer: anonymousKey,
    body: { email, create_user: true, data: { locale } },
  });
  assertAccepted(response, 'otp_send');
  const message = await waitForMessage(email, previousIds);
  return { message, response: response.payload };
}

function extractOtpCode(message) {
  const match = messageText(message).match(/(?:^|\D)(\d{6,10})(?:\D|$)/);
  if (!match) throw new ProbeError('otp_missing');
  return match[1];
}

async function verifyOtp(email, token, type) {
  return request(`${apiUrl}/auth/v1/verify`, {
    method: 'POST',
    apiKey: anonymousKey,
    bearer: anonymousKey,
    body: { email, token, type },
  });
}

async function getAuthenticatedUser(accessToken) {
  const response = await request(`${apiUrl}/auth/v1/user`, {
    apiKey: anonymousKey,
    bearer: accessToken,
  });
  assertAccepted(response, 'user_read');
  if (typeof response.payload?.email !== 'string') throw new ProbeError('user_read');
  return response.payload.email;
}

async function updatePassword(accessToken, password, nonce) {
  return request(`${apiUrl}/auth/v1/user`, {
    method: 'PUT',
    apiKey: anonymousKey,
    bearer: accessToken,
    body: { password, ...(nonce === undefined ? {} : { nonce }) },
  });
}

function responseErrorCode(response) {
  const value = response?.payload?.error_code;
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value) ? value : null;
}

const auditActionNames = [
  'user_signedup',
  'user_confirmation_requested',
  'user_recovery_requested',
  'user_reauthenticate_requested',
  'user_modified',
];

async function readAuditActionsByUser(flowUsers) {
  const userIds = new Set(Object.values(flowUsers).map((user) => user.userId));
  const actionsByUser = new Map([...userIds].map((id) => [id, new Set()]));

  for (const action of auditActionNames) {
    const url = new URL(`${apiUrl}/auth/v1/admin/audit`);
    url.searchParams.set('query', `action:${action}`);
    url.searchParams.set('page', '1');
    url.searchParams.set('per_page', '1000');
    const response = await request(url.href, {
      apiKey: serviceRoleKey,
      bearer: serviceRoleKey,
    });
    assertAccepted(response, 'audit_read');
    if (!Array.isArray(response.payload)) throw new ProbeError('audit_shape');
    for (const entry of response.payload) {
      const payload = entry?.payload ?? entry?.Payload;
      const userId = payload?.actor_id ?? payload?.actorId;
      const loggedAction = payload?.action;
      const userActions = actionsByUser.get(userId);
      if (userActions && loggedAction === action) userActions.add(action);
    }
  }

  return Object.fromEntries(
    Object.entries(flowUsers).map(([flow, user]) => [
      flow,
      [...(actionsByUser.get(user.userId) ?? new Set())].sort(),
    ]),
  );
}

async function runAuditReadCheck() {
  const url = new URL(`${apiUrl}/auth/v1/admin/audit`);
  url.searchParams.set('query', 'action:user_confirmation_requested');
  url.searchParams.set('page', '1');
  url.searchParams.set('per_page', '1000');
  const response = await request(url.href, {
    apiKey: serviceRoleKey,
    bearer: serviceRoleKey,
  });
  assertAccepted(response, 'audit_read');
  if (!Array.isArray(response.payload)) throw new ProbeError('audit_shape');
  const firstPayload = response.payload.find((entry) => {
    const payload = entry?.payload ?? entry?.Payload;
    return typeof (payload?.actor_id ?? payload?.actorId) === 'string';
  });
  const firstActorId =
    firstPayload?.payload?.actor_id ??
    firstPayload?.payload?.actorId ??
    firstPayload?.Payload?.actor_id;
  const actionMap = firstActorId
    ? await readAuditActionsByUser({ probe: { userId: firstActorId } })
    : {};
  return {
    auditReadSucceeded: true,
    returnedRowCount: response.payload.length,
    filteredActionCount: actionMap.probe?.length ?? 0,
  };
}

async function attemptPasswordSignIn(fixture) {
  const response = await request(`${apiUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    apiKey: anonymousKey,
    bearer: anonymousKey,
    body: { email: fixture.email, password: fixture.password },
  });
  assertNotRateLimited(response);
  return {
    accepted: response.ok && typeof response.payload?.access_token === 'string',
    errorCode: response.ok ? null : responseErrorCode(response),
  };
}

function assertNotRateLimited(response) {
  if (response.status === 429) throw new ProbeError('rate_limited');
}

async function sendRecovery(email, previousIds) {
  const response = await request(`${apiUrl}/auth/v1/recover`, {
    method: 'POST',
    apiKey: anonymousKey,
    bearer: anonymousKey,
    body: { email },
  });
  assertAccepted(response, 'recovery_send');
  return waitForMessage(email, previousIds);
}

async function sendReauthentication(accessToken, email, previousIds) {
  const response = await request(`${apiUrl}/auth/v1/reauthenticate`, {
    method: 'GET',
    apiKey: anonymousKey,
    bearer: accessToken,
  });
  assertAccepted(response, 'reauth_send');
  return waitForMessage(email, previousIds);
}

async function sendEmailChange(fixture, locale, previousIds, currentAccessToken) {
  const accessToken = currentAccessToken ?? (await passwordSignIn(fixture));
  const nextEmail = `${randomBytes(18).toString('hex')}@example.invalid`;
  const response = await request(`${apiUrl}/auth/v1/user`, {
    method: 'PUT',
    apiKey: anonymousKey,
    bearer: accessToken,
    body: { email: nextEmail },
  });
  assertAccepted(response, 'email_change_send');
  const [oldMessage, newMessage] = await Promise.all([
    waitForOtpMessage(fixture.email, previousIds),
    waitForOtpMessage(nextEmail, previousIds),
  ]);
  return { oldMessage, newMessage, email: nextEmail, locale };
}

function verifyTemplateMessage(message, expectedLocale, rawLocaleNeedles = []) {
  const body = messageText(message);
  const subject = messageSubject(message).trim();
  const localeCopy = {
    PT: {
      heading: 'Seu código de acesso',
      subject: 'Seu código de acesso',
      expiry: 'Ele expira em 5 minutos',
      nonsharing: 'Não compartilhe',
    },
    EN: {
      heading: 'Your sign-in code',
      subject: 'Your sign-in code',
      expiry: 'It expires in 5 minutes',
      nonsharing: 'Do not share it',
    },
    ES: {
      heading: 'Tu código de acceso',
      subject: 'Tu código de acceso',
      expiry: 'Caduca en 5 minutos',
      nonsharing: 'No lo compartas',
    },
  };
  const expected = localeCopy[expectedLocale];
  const otherHeadings = Object.entries(localeCopy)
    .filter(([locale]) => locale !== expectedLocale)
    .map(([, copy]) => copy.heading);
  return {
    bodyLocaleBranch:
      expected !== undefined &&
      body.includes(expected.heading) &&
      otherHeadings.every((heading) => !body.includes(heading)),
    subjectLocaleBranch: expected !== undefined && subject === expected.subject,
    rawLocaleNotRendered: rawLocaleNeedles.every(
      (needle) => !body.includes(needle) && !subject.includes(needle),
    ),
    codePresent: /\b\d{6,10}\b/.test(body),
    expiryCopyPresent: expected !== undefined && body.includes(expected.expiry),
    nonsharingCopyPresent: expected !== undefined && body.includes(expected.nonsharing),
    noTemplateError: !/(template|function|parse error|W6_SAU1)/i.test(body),
  };
}

function verifySecurityNotification(message, type, locale) {
  const copy = {
    password_changed: {
      PT: { heading: 'Senha alterada', subject: 'Senha alterada' },
      EN: { heading: 'Password changed', subject: 'Password changed' },
      ES: { heading: 'Contraseña cambiada', subject: 'Contraseña cambiada' },
    },
    email_changed: {
      PT: { heading: 'E-mail alterado', subject: 'E-mail alterado' },
      EN: { heading: 'Email changed', subject: 'Email changed' },
      ES: { heading: 'Correo electrónico cambiado', subject: 'Correo electrónico cambiado' },
    },
  };
  const localeCopy = copy[type]?.[locale];
  const body = messageText(message);
  const subject = messageSubject(message).trim();
  const otherHeadings = Object.values(copy[type] ?? {})
    .filter((candidate) => candidate !== localeCopy)
    .map((candidate) => candidate.heading);
  return {
    bodyLocaleBranch:
      localeCopy !== undefined &&
      body.includes(localeCopy.heading) &&
      otherHeadings.every((heading) => !body.includes(heading)),
    subjectLocaleBranch: localeCopy !== undefined && subject === localeCopy.subject,
    noTemplateError: !/(template|function|parse error|W6_SAU1)/i.test(body),
    noFixtureEmailRendered:
      !body.includes('@example.invalid') && !subject.includes('@example.invalid'),
  };
}

function safeErrorCode(error) {
  return error instanceof ProbeError ? error.code : 'unexpected';
}

async function captureCase(id, action) {
  try {
    return { id, ...(await action()) };
  } catch (error) {
    if (error instanceof ProbeError && error.code === 'rate_limited') throw error;
    return { id, safeErrorCode: safeErrorCode(error) };
  }
}

async function runSau1LocaleCases() {
  const checks = [];
  const locales = [
    { id: 'pt_br', value: 'pt-BR', marker: 'PT' },
    { id: 'en', value: 'en', marker: 'EN' },
    { id: 'es', value: 'es', marker: 'ES' },
  ];

  for (const locale of locales) {
    checks.push(
      await captureCase(`${locale.id}_confirmation`, async () => {
        const previousIds = await messageSnapshot();
        const fixture = await publicSignUp({ locale: locale.value });
        const message = await waitForMessage(fixture.email, previousIds);
        return verifyTemplateMessage(message, locale.marker);
      }),
    );

    checks.push(
      await captureCase(`${locale.id}_magic_link`, async () => {
        const credentials = newCredentials();
        const fixture = await adminCreateUser({
          ...credentials,
          locale: locale.value,
        });
        const previousIds = await messageSnapshot();
        const message = await sendMagicLink(fixture.email, previousIds);
        return verifyTemplateMessage(message, locale.marker);
      }),
    );

    checks.push(
      await captureCase(`${locale.id}_recovery`, async () => {
        const credentials = newCredentials();
        const fixture = await adminCreateUser({
          ...credentials,
          locale: locale.value,
        });
        const previousIds = await messageSnapshot();
        const message = await sendRecovery(fixture.email, previousIds);
        return verifyTemplateMessage(message, locale.marker);
      }),
    );

    checks.push(
      await captureCase(`${locale.id}_reauthentication`, async () => {
        const credentials = newCredentials();
        const fixture = await adminCreateUser({
          ...credentials,
          locale: locale.value,
        });
        const accessToken = await passwordSignIn(fixture);
        const previousIds = await messageSnapshot();
        const message = await sendReauthentication(accessToken, fixture.email, previousIds);
        return verifyTemplateMessage(message, locale.marker);
      }),
    );

    checks.push(
      await captureCase(`${locale.id}_email_change`, async () => {
        const credentials = newCredentials();
        const fixture = await adminCreateUser({
          ...credentials,
          locale: locale.value,
        });
        const previousIds = await messageSnapshot();
        const messages = await sendEmailChange(fixture, locale.value, previousIds);
        return {
          oldAddress: verifyTemplateMessage(messages.oldMessage, locale.marker),
          newAddress: verifyTemplateMessage(messages.newMessage, locale.marker),
        };
      }),
    );
  }

  const edgeCases = [
    {
      id: 'unknown_string',
      locale: 'hostile-locale-value',
      needles: ['hostile-locale-value'],
      expected: 'PT',
    },
    {
      id: 'object',
      locale: { value: 'hostile-object-locale' },
      needles: ['hostile-object-locale', 'map[value:hostile-object-locale]'],
      expected: 'PT',
    },
    {
      id: 'array',
      locale: ['hostile-array-locale'],
      needles: ['hostile-array-locale', '[hostile-array-locale]', '["hostile-array-locale"]'],
      expected: 'PT',
    },
    { id: 'number', locale: 734928, needles: ['734928'], expected: 'PT' },
    { id: 'missing', locale: undefined, needles: [], expected: 'PT' },
  ];
  for (const testCase of edgeCases) {
    checks.push(
      await captureCase(`magic_link_${testCase.id}`, async () => {
        const credentials = newCredentials();
        const fixture = await adminCreateUser({
          ...credentials,
          locale: testCase.locale,
        });
        const previousIds = await messageSnapshot();
        const message = await sendMagicLink(fixture.email, previousIds);
        return verifyTemplateMessage(message, testCase.expected, testCase.needles);
      }),
    );
  }
  return checks;
}

async function runSau1ReauthenticationCases() {
  const locales = [
    { id: 'pt_br', value: 'pt-BR', marker: 'PT' },
    { id: 'en', value: 'en', marker: 'EN' },
    { id: 'es', value: 'es', marker: 'ES' },
  ];
  const checks = [];
  for (const locale of locales) {
    checks.push(
      await captureCase(`${locale.id}_reauthentication`, async () => {
        const credentials = newCredentials();
        const fixture = await adminCreateUser({
          ...credentials,
          locale: locale.value,
        });
        const accessToken = await passwordSignIn(fixture);
        const previousIds = await messageSnapshot();
        const message = await sendReauthentication(accessToken, fixture.email, previousIds);
        return verifyTemplateMessage(message, locale.marker);
      }),
    );
  }
  return checks;
}

async function runSau1EnglishRegression() {
  const fixture = await adminCreateUser({ ...newCredentials(), locale: 'en' });
  const accessToken = await passwordSignIn(fixture);
  const previousIds = await messageSnapshot();
  const message = await sendReauthentication(accessToken, fixture.email, previousIds);
  return [verifyTemplateMessage(message, 'EN')];
}

async function runSau2() {
  const directSignupBefore = await messageSnapshot();
  const directSignupFixture = await publicSignUp({ locale: 'pt-BR' });
  const attackerPasswordSignInBeforeConfirmation = await attemptPasswordSignIn(directSignupFixture);
  const directSignupMessage = await waitForMessage(directSignupFixture.email, directSignupBefore);
  const directSignupToken = extractOtpCode(directSignupMessage);
  const directSignupVerification = await verifyOtp(
    directSignupFixture.email,
    directSignupToken,
    'signup',
  );
  assertNotRateLimited(directSignupVerification);

  const directSignupVerifyTypeAccepted =
    directSignupVerification.ok &&
    typeof directSignupVerification.payload?.access_token === 'string';
  const attackerPasswordSignIn = directSignupVerifyTypeAccepted
    ? await attemptPasswordSignIn(directSignupFixture)
    : { accepted: false, errorCode: null };

  const otpSignupCredentials = newCredentials();
  const otpSignupBefore = await messageSnapshot();
  const otpSignup = await sendOtpForSignup(otpSignupCredentials.email, 'pt-BR', otpSignupBefore);
  const returnedUserId = otpSignup.response?.id ?? otpSignup.response?.user?.id;
  if (typeof returnedUserId === 'string') {
    fixtureIds.add(returnedUserId);
    result.fixtureCount += 1;
  } else {
    await findFixtureUserId(otpSignupCredentials.email);
  }
  const otpSignupToken = extractOtpCode(otpSignup.message);
  const otpSignupVerification = await verifyOtp(
    otpSignupCredentials.email,
    otpSignupToken,
    'email',
  );
  assertNotRateLimited(otpSignupVerification);
  const otpSignupAccessToken = otpSignupVerification.payload?.access_token;
  const otpSignupPasswordChangeBefore = await messageSnapshot();
  const otpSignupPasswordUpdate =
    typeof otpSignupAccessToken === 'string'
      ? await updatePassword(otpSignupAccessToken, otpSignupCredentials.password)
      : null;
  if (otpSignupPasswordUpdate) assertNotRateLimited(otpSignupPasswordUpdate);
  const otpSignupPasswordSignIn =
    otpSignupPasswordUpdate?.ok === true
      ? await attemptPasswordSignIn(otpSignupCredentials)
      : { accepted: false, errorCode: null };
  const otpSignupPasswordChangeNotification =
    otpSignupPasswordUpdate?.ok === true
      ? await waitForOptionalMessage(
          otpSignupCredentials.email,
          otpSignupPasswordChangeBefore,
          10_000,
        )
      : null;

  return {
    directSignupVerifyType: 'signup',
    directSignupVerifyTypeAccepted,
    attackerPasswordSignInAcceptedBeforeVictimConfirmation:
      attackerPasswordSignInBeforeConfirmation.accepted,
    attackerPasswordSignInBeforeVictimConfirmationErrorCode:
      attackerPasswordSignInBeforeConfirmation.errorCode,
    attackerPasswordSignInAcceptedAfterVictimConfirmation: attackerPasswordSignIn.accepted,
    attackerPasswordSignInErrorCode: attackerPasswordSignIn.errorCode,
    otpSignupVerifyType: 'email',
    otpSignupVerifyTypeAccepted:
      otpSignupVerification.ok && typeof otpSignupVerification.payload?.access_token === 'string',
    otpSignupVerifyErrorCode: otpSignupVerification.ok
      ? null
      : responseErrorCode(otpSignupVerification),
    otpSignupPasswordSetAccepted: otpSignupPasswordUpdate?.ok === true,
    otpSignupPasswordSetErrorCode:
      otpSignupPasswordUpdate === null || otpSignupPasswordUpdate.ok
        ? null
        : responseErrorCode(otpSignupPasswordUpdate),
    otpSignupPasswordSignInAccepted: otpSignupPasswordSignIn.accepted,
    otpSignupPasswordSignInErrorCode: otpSignupPasswordSignIn.errorCode,
    otpSignupPasswordChangeNotificationReceived: otpSignupPasswordChangeNotification !== null,
  };
}

async function runSau3a() {
  const locales = [
    { id: 'pt_br', value: 'pt-BR', marker: 'PT' },
    { id: 'en', value: 'en', marker: 'EN' },
    { id: 'es', value: 'es', marker: 'ES' },
  ];
  const checks = [];
  for (const locale of locales) {
    result.sau3aProgress = `${locale.id}_fixture`;
    const fixture = await adminCreateUser({ ...newCredentials(), locale: locale.value });
    const accessToken = await passwordSignIn(fixture);
    const previousIds = await messageSnapshot();
    result.sau3aProgress = `${locale.id}_email_change_send`;
    const emailChange = await sendEmailChange(fixture, locale.value, previousIds, accessToken);
    result.sau3aProgress = `${locale.id}_email_change_otp_copy`;
    const emailChangeOtpChecks = {
      oldAddress: verifyTemplateMessage(emailChange.oldMessage, locale.marker),
      newAddress: verifyTemplateMessage(emailChange.newMessage, locale.marker),
    };
    let oldAddressToken;
    try {
      oldAddressToken = extractOtpCode(emailChange.oldMessage);
    } catch (error) {
      result.sau3aProgress = `${locale.id}_old_address_otp_missing`;
      throw error;
    }
    let newAddressToken;
    try {
      newAddressToken = extractOtpCode(emailChange.newMessage);
    } catch (error) {
      result.sau3aProgress = `${locale.id}_new_address_otp_missing`;
      throw error;
    }

    result.sau3aProgress = `${locale.id}_old_address_confirmation`;
    const oldConfirmation = await verifyOtp(fixture.email, oldAddressToken, 'email_change');
    assertNotRateLimited(oldConfirmation);
    const emailAfterOldConfirmation = oldConfirmation.ok
      ? await getAuthenticatedUser(accessToken)
      : null;
    result.sau3aProgress = `${locale.id}_new_address_confirmation`;
    const newConfirmation = await verifyOtp(emailChange.email, newAddressToken, 'email_change');
    assertNotRateLimited(newConfirmation);
    const emailAfterBothConfirmations = newConfirmation.ok
      ? await getAuthenticatedUser(accessToken)
      : null;
    result.sau3aProgress = `${locale.id}_email_changed_notification`;
    const notification = newConfirmation.ok
      ? await waitForOptionalMatchingMessage(
          fixture.email,
          previousIds,
          (message) =>
            Object.values(
              verifySecurityNotification(message, 'email_changed', locale.marker),
            ).every(Boolean),
          10_000,
        )
      : null;
    const notificationChecks = notification
      ? verifySecurityNotification(notification, 'email_changed', locale.marker)
      : null;

    checks.push({
      locale: locale.id,
      oldAddressConfirmationAccepted: oldConfirmation.ok,
      activeEmailStillOldAfterFirstConfirmation: emailAfterOldConfirmation === fixture.email,
      oldAddressErrorCode: oldConfirmation.ok ? null : responseErrorCode(oldConfirmation),
      newAddressConfirmationAccepted: newConfirmation.ok,
      activeEmailChangedAfterBothConfirmations: emailAfterBothConfirmations === emailChange.email,
      newAddressErrorCode: newConfirmation.ok ? null : responseErrorCode(newConfirmation),
      emailChangeOtpChecks,
      nativeEmailChangedNotificationReceived: notification !== null,
      nativeEmailChangedNotificationChecks: notificationChecks,
    });
  }

  return { bothVerifyTypes: 'email_change', localeCases: checks };
}

async function runSau3b() {
  const locales = [
    { id: 'pt_br', value: 'pt-BR', marker: 'PT', nonceRequired: false },
    { id: 'en', value: 'en', marker: 'EN', nonceRequired: true },
    { id: 'es', value: 'es', marker: 'ES', nonceRequired: true },
  ];
  const localeCases = [];
  let updateWithoutNonceAccepted = false;
  let updateWithoutNonceErrorCode = null;
  let updateWithNonceAccepted = true;
  let updateWithNonceErrorCode = null;
  for (const locale of locales) {
    const fixture = await adminCreateUser({ ...newCredentials(), locale: locale.value });
    const accessToken = await passwordSignIn(fixture);
    let nonce;
    if (locale.nonceRequired) {
      const reauthenticationBefore = await messageSnapshot();
      const reauthenticationMessage = await sendReauthentication(
        accessToken,
        fixture.email,
        reauthenticationBefore,
      );
      nonce = extractOtpCode(reauthenticationMessage);
    }
    const passwordChangeBefore = await messageSnapshot();
    const passwordChange = await updatePassword(accessToken, newCredentials().password, nonce);
    assertNotRateLimited(passwordChange);
    if (locale.nonceRequired) {
      updateWithNonceAccepted &&= passwordChange.ok;
      updateWithNonceErrorCode ??= passwordChange.ok ? null : responseErrorCode(passwordChange);
    } else {
      updateWithoutNonceAccepted = passwordChange.ok;
      updateWithoutNonceErrorCode = passwordChange.ok ? null : responseErrorCode(passwordChange);
    }
    const notification = passwordChange.ok
      ? await waitForOptionalMessage(fixture.email, passwordChangeBefore, 10_000)
      : null;
    localeCases.push({
      locale: locale.id,
      passwordUpdateAccepted: passwordChange.ok,
      passwordUpdateErrorCode: passwordChange.ok ? null : responseErrorCode(passwordChange),
      notificationReceived: notification !== null,
      notificationChecks:
        notification === null
          ? null
          : verifySecurityNotification(notification, 'password_changed', locale.marker),
    });
  }
  return {
    updateWithoutNonceAccepted,
    updateWithoutNonceErrorCode,
    updateWithNonceAccepted,
    updateWithNonceErrorCode,
    passwordChangedNotificationLocaleCases: localeCases,
  };
}

async function runSau4() {
  result.sau4Progress = 'confirmation_send';
  const confirmationBefore = await messageSnapshot();
  const confirmationFixture = await publicSignUp({ locale: 'pt-BR' });
  await waitForMessage(confirmationFixture.email, confirmationBefore);

  result.sau4Progress = 'magic_link_send';
  const magicLinkFixture = await adminCreateUser({ ...newCredentials(), locale: 'pt-BR' });
  const magicLinkBefore = await messageSnapshot();
  const magicLinkMessage = await sendMagicLink(magicLinkFixture.email, magicLinkBefore);
  const magicLinkToken = extractOtpCode(magicLinkMessage);

  result.sau4Progress = 'recovery_send';
  const recoveryFixture = await adminCreateUser({ ...newCredentials(), locale: 'pt-BR' });
  const recoveryBefore = await messageSnapshot();
  await sendRecovery(recoveryFixture.email, recoveryBefore);

  result.sau4Progress = 'reauthentication_send';
  const reauthenticationFixture = await adminCreateUser({
    ...newCredentials(),
    locale: 'pt-BR',
  });
  const reauthenticationAccessToken = await passwordSignIn(reauthenticationFixture);
  const reauthenticationBefore = await messageSnapshot();
  await sendReauthentication(
    reauthenticationAccessToken,
    reauthenticationFixture.email,
    reauthenticationBefore,
  );

  result.sau4Progress = 'email_change_send';
  const emailChangeFixture = await adminCreateUser({ ...newCredentials(), locale: 'pt-BR' });
  const emailChangeAccessToken = await passwordSignIn(emailChangeFixture);
  const emailChangeBefore = await messageSnapshot();
  await sendEmailChange(emailChangeFixture, 'pt-BR', emailChangeBefore, emailChangeAccessToken);

  const wrongOtp = `${magicLinkToken[0] === '0' ? '1' : '0'}${magicLinkToken.slice(1)}`;
  const wrongAttemptCount = 10;
  let wrongAttemptsCompleted = 0;
  let wrongAttemptErrorCode = null;
  result.sau4Progress = 'wrong_otp_attempts';
  for (let attempt = 1; attempt <= wrongAttemptCount; attempt += 1) {
    const response = await verifyOtp(magicLinkFixture.email, wrongOtp, 'email');
    if (response.status === 429) {
      result.sau4 = {
        wrongOtpAttemptsCompleted: wrongAttemptsCompleted,
        wrongOtpRateLimitedAtAttempt: attempt,
        wrongOtpRateLimitErrorCode: responseErrorCode(response),
        ipv6PrefixGroupingProven: false,
      };
      return result.sau4;
    }
    wrongAttemptsCompleted += 1;
    wrongAttemptErrorCode ??= responseErrorCode(response);
  }

  const correctAfterWrongAttempts = await verifyOtp(
    magicLinkFixture.email,
    magicLinkToken,
    'email',
  );
  assertNotRateLimited(correctAfterWrongAttempts);

  result.sau4Progress = 'audit_actions';
  const auditActionsByFlow = await readAuditActionsByUser({
    confirmation: confirmationFixture,
    magic_link: magicLinkFixture,
    recovery: recoveryFixture,
    reauthentication: reauthenticationFixture,
    email_change: emailChangeFixture,
  });
  const emailSendActionNames = [...new Set(Object.values(auditActionsByFlow).flat())].sort();

  result.sau4Progress = 'max_frequency_retry';
  const beforeFrequencyRetry = await messageSnapshot();
  const frequencyRetry = await request(`${apiUrl}/auth/v1/otp`, {
    method: 'POST',
    apiKey: anonymousKey,
    bearer: anonymousKey,
    body: { email: magicLinkFixture.email, create_user: false },
  });
  let frequencyRetryMessageReceived = null;
  if (frequencyRetry.status !== 429 && frequencyRetry.ok) {
    frequencyRetryMessageReceived =
      (await waitForOptionalMessage(magicLinkFixture.email, beforeFrequencyRetry, 2_000)) !== null;
  }

  result.sau4Progress = 'complete';
  return {
    wrongOtpAttemptsCompleted: wrongAttemptsCompleted,
    wrongOtpAttemptErrorCode: wrongAttemptErrorCode,
    correctOtpAcceptedAfterWrongAttempts:
      correctAfterWrongAttempts.ok &&
      typeof correctAfterWrongAttempts.payload?.access_token === 'string',
    correctOtpErrorCode: correctAfterWrongAttempts.ok
      ? null
      : responseErrorCode(correctAfterWrongAttempts),
    ipv6PrefixGroupingProven: false,
    auditActionsByFlow,
    emailSendActionNames,
    maxFrequencyRetryStatus: frequencyRetry.status,
    maxFrequencyRetryErrorCode: responseErrorCode(frequencyRetry),
    maxFrequencyRetryBlocked: frequencyRetry.status === 429,
    frequencyRetryMessageReceived,
  };
}

async function deleteFixtureUsers() {
  for (const id of fixtureIds) {
    const response = await request(`${apiUrl}/auth/v1/admin/users/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      apiKey: serviceRoleKey,
      bearer: serviceRoleKey,
    });
    if (response.ok) result.cleanupCount += 1;
  }
  result.cleanupComplete = result.cleanupCount === result.fixtureCount;
}

async function deleteFixtureMessages() {
  if (mailpitMessageIds.size === 0) {
    result.messageCleanupComplete = true;
    return;
  }
  const response = await request(`${mailpitUrl}/api/v1/messages`, {
    method: 'DELETE',
    body: { IDs: [...mailpitMessageIds] },
  });
  assertAccepted(response, 'mailpit_cleanup');
  result.messageCleanupCount = mailpitMessageIds.size;
  result.messageCleanupComplete = response.ok;
}

function collectTemplateCheckResults(value, output = []) {
  if (!value || typeof value !== 'object') return output;
  if (Object.hasOwn(value, 'bodyLocaleBranch')) output.push(value);
  else {
    for (const [key, nested] of Object.entries(value)) {
      if (key !== 'id') collectTemplateCheckResults(nested, output);
    }
  }
  return output;
}

async function run() {
  loadLocalStatus();
  if (suite === 'sau1') {
    result.sau1Templates = await runSau1LocaleCases();
  } else if (suite === 'sau1-reauth') {
    result.sau1Reauthentication = await runSau1ReauthenticationCases();
  } else if (suite === 'sau1-en') {
    result.sau1English = await runSau1EnglishRegression();
  } else if (suite === 'sau2') {
    result.sau2 = await runSau2();
  } else if (suite === 'sau2-acceptance') {
    result.sau2Acceptance = await runSau2();
  } else if (suite === 'sau3a') {
    result.sau3a = await runSau3a();
  } else if (suite === 'sau3b') {
    result.sau3b = await runSau3b();
  } else if (suite === 'sau4') {
    result.sau4 = await runSau4();
  } else if (suite === 'audit-read') {
    result.auditReadCheck = await runAuditReadCheck();
  } else {
    throw new ProbeError('unsupported_suite');
  }
  result.measurementComplete = true;
}

try {
  await run();
} catch (error) {
  result.safeErrorCode = error instanceof ProbeError ? error.code : 'unexpected';
  if (!(error instanceof ProbeError) && typeof error?.name === 'string')
    result.safeErrorName = /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'unknown';
} finally {
  if (apiUrl && serviceRoleKey) {
    try {
      await deleteFixtureUsers();
    } catch {
      result.cleanupComplete = false;
    }
  }
  if (mailpitMessageIds.size > 0) {
    try {
      await deleteFixtureMessages();
    } catch {
      result.messageCleanupComplete = false;
    }
  } else {
    result.messageCleanupComplete = true;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  const allTemplateChecks = [
    ...collectTemplateCheckResults(result.sau1Templates),
    ...collectTemplateCheckResults(result.sau1Reauthentication),
    ...collectTemplateCheckResults(result.sau1English),
  ];
  const casesWithErrors = [result.sau1Templates, result.sau1Reauthentication, result.sau1English]
    .filter(Array.isArray)
    .some((suiteChecks) => suiteChecks.some((item) => item?.safeErrorCode));
  const templateSuiteRequested = suite === 'sau1' || suite === 'sau1-reauth' || suite === 'sau1-en';
  const notificationSuiteRequested = suite === 'sau3a' || suite === 'sau3b';
  const templateChecksFailed =
    templateSuiteRequested &&
    (casesWithErrors ||
      allTemplateChecks.length === 0 ||
      allTemplateChecks.some(
        (item) =>
          !item.bodyLocaleBranch ||
          !item.subjectLocaleBranch ||
          !item.rawLocaleNotRendered ||
          !item.codePresent ||
          !item.expiryCopyPresent ||
          !item.nonsharingCopyPresent ||
          !item.noTemplateError,
      ));
  const notificationChecks =
    suite === 'sau3a'
      ? (result.sau3a?.localeCases ?? []).map((item) => ({
          received: item.nativeEmailChangedNotificationReceived,
          checks: item.nativeEmailChangedNotificationChecks,
        }))
      : suite === 'sau3b'
        ? (result.sau3b?.passwordChangedNotificationLocaleCases ?? []).map((item) => ({
            received: item.notificationReceived,
            checks: item.notificationChecks,
          }))
        : [];
  const emailChangeOtpChecks =
    suite === 'sau3a'
      ? (result.sau3a?.localeCases ?? []).flatMap((item) =>
          Object.values(item.emailChangeOtpChecks ?? {}),
        )
      : [];
  const emailChangeOtpChecksFailed =
    suite === 'sau3a' &&
    (emailChangeOtpChecks.length !== 6 ||
      emailChangeOtpChecks.some(
        (item) =>
          !item.bodyLocaleBranch ||
          !item.subjectLocaleBranch ||
          !item.codePresent ||
          !item.expiryCopyPresent ||
          !item.nonsharingCopyPresent ||
          !item.noTemplateError,
      ));
  const securityNotificationChecksFailed =
    (notificationSuiteRequested &&
      (notificationChecks.length === 0 ||
        notificationChecks.some(
          (item) =>
            !item.received ||
            !item.checks?.bodyLocaleBranch ||
            !item.checks?.subjectLocaleBranch ||
            !item.checks?.noTemplateError ||
            !item.checks?.noFixtureEmailRendered,
        ))) ||
    emailChangeOtpChecksFailed;
  const preHijackAcceptanceFailed =
    suite === 'sau2-acceptance' &&
    (!result.sau2Acceptance?.directSignupVerifyTypeAccepted ||
      result.sau2Acceptance.attackerPasswordSignInAcceptedBeforeVictimConfirmation ||
      result.sau2Acceptance.attackerPasswordSignInAcceptedAfterVictimConfirmation ||
      !result.sau2Acceptance.otpSignupVerifyTypeAccepted ||
      !result.sau2Acceptance.otpSignupPasswordSetAccepted ||
      !result.sau2Acceptance.otpSignupPasswordSignInAccepted);
  if (
    result.safeErrorCode ||
    !result.cleanupComplete ||
    !result.messageCleanupComplete ||
    !result.measurementComplete ||
    templateChecksFailed ||
    securityNotificationChecksFailed ||
    preHijackAcceptanceFailed
  )
    process.exitCode = 1;
}
