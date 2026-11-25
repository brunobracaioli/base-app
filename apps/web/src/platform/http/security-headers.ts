import staticSecurityHeaders from './static-security-headers.json';

export const STATIC_SECURITY_HEADERS = staticSecurityHeaders satisfies Readonly<
  Record<string, string>
>;

export function applySecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(STATIC_SECURITY_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  headers.set('Cache-Control', 'no-store');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
