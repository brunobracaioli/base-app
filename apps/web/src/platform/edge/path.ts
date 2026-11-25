export type NormalizedPath = { readonly value: string };

const forbiddenEncoding = /%(?:2f|5c|2e|00)/i;

export function normalizePath(path: string): NormalizedPath | null {
  if (!path.startsWith('/') || path.includes('?') || path.includes('#')) return null;
  if (path.includes('\\') || forbiddenEncoding.test(path)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (decoded.includes('\\') || decoded.includes('\0')) return null;
  if (decoded.startsWith('//') || decoded.includes('//')) return null;

  const segments = decoded.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) return null;
  const normalized = `/${segments.filter((segment) => segment.length > 0).join('/')}`;
  return { value: normalized.toLowerCase() };
}

export function normalizePathPrefix(prefix: string): NormalizedPath | null {
  if (!prefix.startsWith('/') || prefix.includes('?') || prefix.includes('#')) return null;
  const normalized = normalizePath(prefix);
  if (!normalized) return null;
  return { value: normalized.value === '/' ? '/' : normalized.value.replace(/\/$/, '') };
}

export function isPathWithinPrefix(path: string, prefix: string): boolean {
  if (prefix === '/') return path.startsWith('/');
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function normalizeHost(host: string): string | null {
  const candidate = host.trim().toLowerCase();
  if (!candidate || /[\s,/@\\?#]/.test(candidate)) return null;
  try {
    const parsed = new URL(`https://${candidate}`);
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
    const port = parsed.port && parsed.port !== '443' ? `:${parsed.port}` : '';
    return `${hostname}${port}`;
  } catch {
    return null;
  }
}
