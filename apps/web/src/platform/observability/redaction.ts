const LOG_SENSITIVE_FIELD_PATTERN =
  /token|secret|password|authorization|cookie|code|email|signature/i;
const SENTRY_SENSITIVE_FIELD_PATTERN =
  /token|secret|password|authorization|cookie|code|email|signature|name|address|phone|cpf|body|message/i;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const JWT_PATTERN = /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g;
const REDACTED = '[REDACTED]';

export function redactText(value: string): string {
  return value.replace(EMAIL_PATTERN, REDACTED).replace(JWT_PATTERN, REDACTED);
}

export function redactValue(
  value: unknown,
  depth = 0,
  sensitiveFieldPattern: RegExp = LOG_SENSITIVE_FIELD_PATTERN,
): unknown {
  if (depth > 20) return REDACTED;
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value))
    return value.map((entry) => redactValue(entry, depth + 1, sensitiveFieldPattern));
  if (typeof value !== 'object' || value === null) return value;

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = sensitiveFieldPattern.test(key)
      ? REDACTED
      : redactValue(entry, depth + 1, sensitiveFieldPattern);
  }
  return redacted;
}

export function redactSentryEvent<Event extends object>(event: Event): Event {
  const redacted = redactValue(event, 0, SENTRY_SENSITIVE_FIELD_PATTERN) as Event;
  const request = (redacted as { readonly request?: unknown }).request;
  if (typeof request === 'object' && request !== null && !Array.isArray(request)) {
    delete (request as Record<string, unknown>).data;
    delete (request as Record<string, unknown>).cookies;
    const url = (request as Record<string, unknown>).url;
    if (typeof url === 'string') {
      try {
        const parsed = new URL(url);
        (request as Record<string, unknown>).url = `${parsed.origin}${parsed.pathname}`;
      } catch {
        (request as Record<string, unknown>).url = REDACTED;
      }
    }
  }
  return redacted;
}
