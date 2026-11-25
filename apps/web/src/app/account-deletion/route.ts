import { applySecurityHeaders } from '../../platform/http/security-headers';

const UNAVAILABLE_PAGE =
  '<!doctype html><html lang="en"><meta charset="utf-8"><title>Service unavailable</title><body><main><h1>Service unavailable</h1></main></body></html>';

export function GET(request: Request): Response {
  const nonce = request.headers.get('x-csp-nonce');
  if (!nonce || !/^[A-Za-z0-9+/=_-]{16,}$/.test(nonce)) {
    return applySecurityHeaders(
      new Response(UNAVAILABLE_PAGE, {
        status: 503,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }),
    );
  }

  return applySecurityHeaders(
    new Response(UNAVAILABLE_PAGE, {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }),
  );
}
