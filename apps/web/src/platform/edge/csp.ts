import type { CspDirective, EdgeExtension } from '../extensions/types';
import { isPathWithinPrefix, normalizePath, normalizePathPrefix } from './path';

const CSP_DIRECTIVES = new Set<CspDirective>([
  'script-src',
  'frame-src',
  'connect-src',
  'style-src',
  'img-src',
]);
const hardeningValues = {
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Robots-Tag': 'noindex, nofollow',
  'Cache-Control': 'no-store',
} as const;

export type CspPolicy = ReadonlyMap<string, readonly string[]>;

function validateOrigin(source: string): void {
  let origin: URL;
  try {
    origin = new URL(source);
  } catch {
    throw new TypeError('CSP origins must be explicit HTTPS origins.');
  }
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== source ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  ) {
    throw new TypeError('CSP origins must be explicit HTTPS origins without paths.');
  }
}

function validateTrustedTypes(policies: readonly string[]): void {
  if (policies.length > 5 || new Set(policies).size !== policies.length) {
    throw new TypeError('Trusted Types accepts at most five unique policies.');
  }
  for (const policy of policies) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(policy)) {
      throw new TypeError('Trusted Types policy name is invalid.');
    }
  }
}

export function validateEdgeCsp(extensions: readonly EdgeExtension[]): void {
  for (const extension of extensions) {
    const seenPrefixes = new Set<string>();
    for (const item of extension.csp ?? []) {
      const prefix = normalizePathPrefix(item.pathPrefix);
      if (!prefix) throw new TypeError(`Invalid CSP path prefix in extension ${extension.name}.`);
      if (prefix.value === '/')
        throw new TypeError('CSP additions are not allowed on the root path.');
      if (seenPrefixes.has(prefix.value))
        throw new TypeError(`Duplicate CSP prefix in extension ${extension.name}.`);
      seenPrefixes.add(prefix.value);

      const accountDeletion = isPathWithinPrefix('/account-deletion', prefix.value);
      const directiveEntries = Object.entries(item.directives) as [
        CspDirective,
        readonly string[],
      ][];
      for (const [directive, sources] of directiveEntries) {
        if (!CSP_DIRECTIVES.has(directive))
          throw new TypeError('CSP directive is not allowlisted.');
        if (accountDeletion && !['script-src', 'frame-src', 'connect-src'].includes(directive)) {
          throw new TypeError(
            'CSP under /account-deletion only permits script-src, frame-src and connect-src.',
          );
        }
        if (accountDeletion && sources.length > 2) {
          throw new TypeError(
            'CSP under /account-deletion permits at most two origins per directive.',
          );
        }
        if (sources.length > 8)
          throw new TypeError('CSP additions permit at most eight origins per directive.');
        for (const source of sources) validateOrigin(source);
      }
      if (item.strict) validateTrustedTypes(item.strict.trustedTypesPolicies);
    }
  }
}

function basePolicy(nonce: string): Map<string, string[]> {
  return new Map([
    ['default-src', ["'self'"]],
    ['script-src', ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"]],
    ['style-src', ["'self'", `'nonce-${nonce}'`]],
    ['img-src', ["'self'"]],
    ['font-src', ["'self'"]],
    ['connect-src', ["'self'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
  ]);
}

function strictBasePolicy(nonce: string, policies: readonly string[]): Map<string, string[]> {
  return new Map([
    ['default-src', ["'none'"]],
    ['script-src', ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"]],
    ['style-src', ["'self'", `'nonce-${nonce}'`]],
    ['img-src', ["'self'"]],
    ['font-src', ["'self'"]],
    ['connect-src', ["'self'"]],
    ['object-src', ["'none'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['require-trusted-types-for', ["'script'"]],
    ['trusted-types', [...policies]],
  ]);
}

function addSources(
  policy: Map<string, string[]>,
  directive: string,
  sources: readonly string[],
): void {
  const current = policy.get(directive) ?? [];
  policy.set(directive, [...new Set([...current, ...sources])]);
}

export function buildContentSecurityPolicy(
  nonce: string,
  path: string,
  extensions: readonly EdgeExtension[],
): string {
  const normalizedPath = normalizePath(path);
  if (!normalizedPath) throw new TypeError('Request path could not be normalized for CSP.');
  validateEdgeCsp(extensions);

  const matching = extensions.flatMap((extension) =>
    (extension.csp ?? [])
      .filter((item) => {
        const prefix = normalizePathPrefix(item.pathPrefix);
        return prefix !== null && isPathWithinPrefix(normalizedPath.value, prefix.value);
      })
      .map((item) => ({ item, extensionName: extension.name })),
  );
  const strict = matching.find(({ item }) => item.strict)?.item.strict;
  const policy = strict ? strictBasePolicy(nonce, strict.trustedTypesPolicies) : basePolicy(nonce);

  for (const { item } of matching) {
    for (const [directive, sources] of Object.entries(item.directives) as [
      CspDirective,
      readonly string[],
    ][]) {
      addSources(policy, directive, sources);
    }
  }

  return [...policy.entries()]
    .map(([directive, sources]) => `${directive} ${sources.join(' ')}`)
    .join('; ');
}

export function hardeningHeadersForPath(
  path: string,
  extensions: readonly EdgeExtension[],
): Readonly<Record<string, string>> {
  const normalizedPath = normalizePath(path);
  if (!normalizedPath) return {};
  const result: Record<string, string> = {};
  for (const extension of extensions) {
    for (const item of extension.headers ?? []) {
      const prefix = normalizePathPrefix(item.pathPrefix);
      if (!prefix || !isPathWithinPrefix(normalizedPath.value, prefix.value)) continue;
      for (const [name, value] of Object.entries(item.set)) {
        const expected = hardeningValues[name as keyof typeof hardeningValues];
        if (expected === undefined || value !== expected) {
          throw new TypeError(`Invalid edge hardening header in extension ${extension.name}.`);
        }
        const previous = result[name];
        if (previous !== undefined && previous !== value) {
          throw new TypeError(`Conflicting edge hardening header in extension ${extension.name}.`);
        }
        result[name] = value;
      }
    }
  }
  return result;
}

export function validateEdgeHeaders(extensions: readonly EdgeExtension[]): void {
  for (const extension of extensions) {
    const prefixes = new Set<string>();
    for (const item of extension.headers ?? []) {
      const prefix = normalizePathPrefix(item.pathPrefix);
      if (!prefix)
        throw new TypeError(`Invalid hardening-header prefix in extension ${extension.name}.`);
      if (prefixes.has(prefix.value))
        throw new TypeError(`Duplicate hardening-header prefix in extension ${extension.name}.`);
      prefixes.add(prefix.value);
      for (const [name, value] of Object.entries(item.set)) {
        const expected = hardeningValues[name as keyof typeof hardeningValues];
        if (expected === undefined || value !== expected) {
          throw new TypeError(`Invalid edge hardening header in extension ${extension.name}.`);
        }
      }
    }
  }
}
