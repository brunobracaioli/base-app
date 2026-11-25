import { ProblemDetailsSchema, type ProblemDetails } from '@base-app/contracts';

export class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly responseHeaders?: HeadersInit,
  ) {
    super(`${status} ${code}`);
    this.name = 'HttpProblem';
  }
}

export function problemResponse(
  status: number,
  code: string,
  title: string,
  requestId: string,
  extraHeaders?: HeadersInit,
): Response {
  const problem: ProblemDetails = ProblemDetailsSchema.parse({
    type: 'about:blank',
    title,
    status,
    code,
    requestId,
  });
  const headers = new Headers(extraHeaders);
  headers.set('Content-Type', 'application/problem+json');
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Request-Id', requestId);
  return new Response(JSON.stringify(problem), { status, headers });
}
