import { createHash, timingSafeEqual } from 'node:crypto';
import { Webhook } from 'standardwebhooks';

import { createLogger } from '../observability/logger';
import type { AppLogger } from '../observability/logger';
export type WebhookVerificationInput = {
  readonly request: Request;
  readonly body: Uint8Array;
  readonly now: Date;
};

export type WebhookVerifier = (input: WebhookVerificationInput) => Promise<boolean>;

type SecretEntry = {
  readonly name: string;
  readonly value: string;
  readonly expiresAt: Date | null;
};

const MAX_ROTATED_SECRETS = 3;
const MAX_ROTATION_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const EMPTY_SECRET_HASH = createHash('sha256').update('', 'utf8').digest();
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function loadSecrets(
  envNames: readonly [string, ...string[]],
  environment: Readonly<Record<string, string | undefined>>,
  now: Date,
): readonly SecretEntry[] {
  if (envNames.length > MAX_ROTATED_SECRETS || new Set(envNames).size !== envNames.length) {
    throw new TypeError(
      'Webhook secret rotation accepts at most three distinct environment names.',
    );
  }
  return envNames.map((name, index) => {
    const value = environment[name];
    if (!value) throw new TypeError('A configured webhook secret is missing.');
    if (index === 0) return { name, value, expiresAt: null };

    const expiresValue = environment[`${name}_EXPIRES_AT`];
    if (!expiresValue || !ISO_TIMESTAMP.test(expiresValue)) {
      throw new TypeError('Rotated webhook secrets require an ISO 8601 _EXPIRES_AT value.');
    }
    const expiresAtMs = expiresValue ? Date.parse(expiresValue) : Number.NaN;
    if (!Number.isFinite(expiresAtMs)) {
      throw new TypeError('Rotated webhook secrets require a valid _EXPIRES_AT value.');
    }
    if (expiresAtMs > now.getTime() + MAX_ROTATION_AGE_MS) {
      throw new TypeError('Rotated webhook secret expiry may not exceed 30 days.');
    }
    return { name, value, expiresAt: new Date(expiresAtMs) };
  });
}

function digest(value: string): Uint8Array {
  return createHash('sha256').update(value, 'utf8').digest();
}

function constantTimeEqual(candidate: string, secret: string): boolean {
  const candidateHash = candidate.length === 0 ? EMPTY_SECRET_HASH : digest(candidate);
  const secretHash = digest(secret);
  return timingSafeEqual(candidateHash, secretHash);
}

function activeSecret(
  secret: SecretEntry,
  now: Date,
  logger: AppLogger,
  warned: Set<string>,
): boolean {
  if (secret.expiresAt === null || secret.expiresAt.getTime() > now.getTime()) return true;
  if (!warned.has(secret.name)) {
    warned.add(secret.name);
    logger.warn('Expired rotated webhook secret ignored', { secretName: secret.name });
  }
  return false;
}

export function sharedSecret(
  envNames: readonly [string, ...string[]],
  environment: Readonly<Record<string, string | undefined>> = process.env,
  configuredAt = new Date(),
  logger: AppLogger = createLogger(),
): WebhookVerifier {
  const secrets = loadSecrets(envNames, environment, configuredAt);
  const warnedExpiredSecrets = new Set<string>();
  return async ({ request, now }) => {
    const authorization = request.headers.get('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    const candidate = match?.[1] ?? '';
    let accepted = false;
    for (const secret of secrets) {
      const isActive = activeSecret(secret, now, logger, warnedExpiredSecrets);
      const matches = constantTimeEqual(candidate, secret.value);
      accepted = Boolean(Number(accepted) | Number(isActive && matches));
    }
    return accepted;
  };
}

export function standardWebhooks(
  envNames: readonly [string, ...string[]],
  environment: Readonly<Record<string, string | undefined>> = process.env,
  configuredAt = new Date(),
  logger: AppLogger = createLogger(),
): WebhookVerifier {
  const secrets = loadSecrets(envNames, environment, configuredAt);
  const warnedExpiredSecrets = new Set<string>();
  return async ({ request, body, now }) => {
    const headers = {
      'webhook-id': request.headers.get('webhook-id') ?? '',
      'webhook-timestamp': request.headers.get('webhook-timestamp') ?? '',
      'webhook-signature': request.headers.get('webhook-signature') ?? '',
    };
    let accepted = false;
    for (const secret of secrets) {
      const isActive = activeSecret(secret, now, logger, warnedExpiredSecrets);
      let matches: boolean;
      try {
        new Webhook(secret.value).verify(body, headers);
        matches = true;
      } catch {
        matches = false;
      }
      accepted = Boolean(Number(accepted) | Number(isActive && matches));
    }
    return accepted;
  };
}
