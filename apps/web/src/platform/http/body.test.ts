import { describe, expect, it } from 'vitest';

import { decodeUtf8, parseJsonBody, readBoundedBody } from './body';
import { HttpProblem } from './problem';

describe('bounded request bodies', () => {
  it('rejects a declared body size before reading the body', async () => {
    const request = new Request('https://app.example/', {
      method: 'POST',
      headers: { 'content-length': '10' },
      body: '0123456789',
    });
    await expect(readBoundedBody(request, 4)).rejects.toMatchObject({
      status: 413,
      code: 'request.body_too_large',
    });
  });

  it('cuts a streamed body off when it exceeds the route limit', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('abc'));
        controller.enqueue(new TextEncoder().encode('def'));
        controller.close();
      },
    });
    const request = new Request('https://app.example/', {
      method: 'POST',
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    await expect(readBoundedBody(request, 4)).rejects.toBeInstanceOf(HttpProblem);
  });

  it('rejects invalid UTF-8 and malformed JSON without exposing parser details', () => {
    expect(() => decodeUtf8(new Uint8Array([0xff]))).toThrow(HttpProblem);
    expect(() => parseJsonBody(new TextEncoder().encode('{bad'))).toThrowError(
      expect.objectContaining({ code: 'request.invalid_body' }),
    );
  });
});
