import { createTimedAuthFetch, MAX_AUTH_RESPONSE_BYTES } from './supabase-client';

describe('Supabase Auth request timeout', () => {
  it('keeps the deadline active while the response body is read', async () => {
    jest.useFakeTimers();
    try {
      const fetch = jest.fn<Promise<Response>, Parameters<typeof globalThis.fetch>>(
        async (_input, init) =>
          ({
            status: 200,
            headers: new Headers(),
            json: () =>
              new Promise((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
                  once: true,
                });
              }),
          }) as Response,
      );
      const timedFetch = createTimedAuthFetch(fetch, undefined, 25);
      const response = await timedFetch('https://auth.example.invalid/auth/v1/user');
      const bodyRead = response.json();
      const rejected = expect(bodyRead).rejects.toThrow('Authentication request failed.');

      await jest.advanceTimersByTimeAsync(25);
      await rejected;
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('supports the React Native Response shape when body is not exposed', async () => {
    const bodyText = JSON.stringify({ status: 'ok' });
    const response = {
      status: 200,
      headers: new Headers(),
      text: jest.fn(async () => bodyText),
      json: jest.fn(async () => ({ status: 'ok' })),
    } as unknown as Response;
    const fetch = jest
      .fn<Promise<Response>, Parameters<typeof globalThis.fetch>>()
      .mockResolvedValue(response);
    const timedFetch = createTimedAuthFetch(fetch, undefined, 25);

    await expect(
      (await timedFetch('https://auth.example.invalid/auth/v1/user')).json(),
    ).resolves.toEqual({
      status: 'ok',
    });
    expect(response.text).toHaveBeenCalledTimes(1);
    expect(response.json).not.toHaveBeenCalled();
  });

  it('checks the buffered React Native body before JSON parsing without Content-Length', async () => {
    const response = {
      status: 200,
      headers: new Headers(),
      _bodyText: 'x'.repeat(MAX_AUTH_RESPONSE_BYTES + 1),
      text: jest.fn(async () => 'unused'),
      json: jest.fn(async () => ({ status: 'unused' })),
    } as unknown as Response;
    const fetch = jest
      .fn<Promise<Response>, Parameters<typeof globalThis.fetch>>()
      .mockResolvedValue(response);
    const timedFetch = createTimedAuthFetch(fetch, undefined, 25);

    await expect(timedFetch('https://auth.example.invalid/auth/v1/user')).rejects.toThrow(
      'Authentication response is too large.',
    );
    expect(response.text).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
  });

  it('rejects an Auth response above the bounded payload size', async () => {
    const fetch = jest
      .fn<Promise<Response>, Parameters<typeof globalThis.fetch>>()
      .mockResolvedValue({
        status: 200,
        headers: new Headers({ 'content-length': String(MAX_AUTH_RESPONSE_BYTES + 1) }),
        body: null,
      } as Response);
    const timedFetch = createTimedAuthFetch(fetch, undefined, 25);

    await expect(timedFetch('https://auth.example.invalid/auth/v1/user')).rejects.toThrow(
      'Authentication response is too large.',
    );
  });

  it('bounds streamed response bodies when Content-Length is absent', async () => {
    const oversizedChunk = new Uint8Array(MAX_AUTH_RESPONSE_BYTES + 1);
    const fetch = jest
      .fn<Promise<Response>, Parameters<typeof globalThis.fetch>>()
      .mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(oversizedChunk);
              controller.close();
            },
          }),
          { status: 200 },
        ),
      );
    const timedFetch = createTimedAuthFetch(fetch, undefined, 25);

    await expect(timedFetch('https://auth.example.invalid/auth/v1/user')).rejects.toThrow(
      'Authentication response is too large.',
    );
  });
});
