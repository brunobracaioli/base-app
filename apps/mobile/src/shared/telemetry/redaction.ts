const sensitiveKeyPattern = /(?:email|e-mail|token|secret|password|authorization|code|name)/i;
const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const bearerPattern = /\bBearer\s+[A-Z0-9._~+/-]+=*/gi;
const jwtPattern = /\beyJ[A-Z0-9_-]{10,}\.[A-Z0-9_-]{10,}(?:\.[A-Z0-9_-]+)?\b/gi;
const codeQueryPattern =
  /([?&](?:email|code|token|access_token|refresh_token|password)=)[^&#\s]*/gi;
const sensitiveAssignmentPattern =
  /\b(email|e-mail|code|token|access_token|refresh_token|password|secret|authorization)\s*[:=]\s*["']?[^\s,;&"']+/gi;
const numericCodePattern = /\b\d{6,8}\b/g;

function redactString(value: string): string {
  return value
    .replace(emailPattern, '[redacted]')
    .replace(bearerPattern, 'Bearer [redacted]')
    .replace(jwtPattern, '[redacted]')
    .replace(codeQueryPattern, '$1[redacted]')
    .replace(sensitiveAssignmentPattern, '$1=[redacted]')
    .replace(numericCodePattern, '[redacted]');
}

function sanitize(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return '[circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => sanitize(entry, seen));
  }

  const output: Record<string, unknown> = {};
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (sensitiveKeyPattern.test(key) || !('value' in descriptor)) {
      continue;
    }
    output[key] = sanitize(descriptor.value, seen);
  }
  return output;
}

export function redactTelemetryEvent<T>(event: T): T {
  return sanitize(event, new WeakSet()) as T;
}

export function redactTelemetryBreadcrumb<T>(breadcrumb: T): T | null {
  if (typeof breadcrumb === 'object' && breadcrumb !== null) {
    const categoryDescriptor = Object.getOwnPropertyDescriptor(breadcrumb, 'category');
    const category =
      categoryDescriptor !== undefined && 'value' in categoryDescriptor
        ? categoryDescriptor.value
        : undefined;
    if (
      category === 'navigation' ||
      (typeof category === 'string' && category.startsWith('router.'))
    ) {
      return null;
    }
  }
  if (typeof breadcrumb !== 'object' || breadcrumb === null) {
    return breadcrumb;
  }
  if (Object.getOwnPropertyDescriptor(breadcrumb, 'category') === undefined) {
    return redactTelemetryEvent(breadcrumb);
  }
  if (Object.getOwnPropertyDescriptor(breadcrumb, 'category')?.get !== undefined) {
    return null;
  }
  return redactTelemetryEvent(breadcrumb);
}
