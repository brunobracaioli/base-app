import { HttpProblem } from './problem';

export async function readBoundedBody(request: Request, maxBodyBytes: number): Promise<Uint8Array> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null && /^\d+$/.test(declaredLength)) {
    const length = Number(declaredLength);
    if (Number.isSafeInteger(length) && length > maxBodyBytes) {
      throw new HttpProblem(413, 'request.body_too_large', 'Request body is too large.');
    }
  }

  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBodyBytes) {
      await reader.cancel();
      throw new HttpProblem(413, 'request.body_too_large', 'Request body is too large.');
    }
    chunks.push(value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function decodeUtf8(body: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new HttpProblem(400, 'request.invalid_encoding', 'Request body is not valid UTF-8.');
  }
}

export function parseJsonBody(body: Uint8Array): unknown {
  if (body.byteLength === 0) {
    throw new HttpProblem(400, 'request.invalid_body', 'Request body is required.');
  }
  try {
    return JSON.parse(decodeUtf8(body)) as unknown;
  } catch (error) {
    if (error instanceof HttpProblem) throw error;
    throw new HttpProblem(400, 'request.invalid_body', 'Request body is not valid JSON.');
  }
}
