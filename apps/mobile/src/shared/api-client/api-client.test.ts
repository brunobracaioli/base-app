import { coreEndpoints, ProblemDetailsSchema } from '@base-app/contracts';
import { createMobileI18n, setActiveMobileI18n, translateMobile } from '../i18n';
import { createApiClient, createUuidV7, ApiRequestError } from './api-client';

const requestId = '018f7c2a-6b4e-7a21-8e33-4c10b0010001';

function response(
  body: unknown,
  status = 200,
  contentType = 'application/json',
  extraHeaders: Readonly<Record<string, string>> = {},
): Response {
  const headers = new Headers({ 'content-type': contentType, ...extraHeaders });
  const result = {
    ok: status >= 200 && status < 300,
    status,
    headers,
    body: { cancel: jest.fn().mockResolvedValue(undefined) },
    json: jest.fn().mockResolvedValue(body),
    clone: () => response(body, status, contentType),
  };
  return result as unknown as Response;
}

const privateHealthEndpoint = {
  ...coreEndpoints[0],
  security: [{ bearerAuth: [] }],
} as const;

describe('typed API client', () => {
  it('creates a UUIDv7 request identifier', () => {
    const id = createUuidV7(1_700_000_000_000, new Uint8Array(16));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('records safe request and response correlation breadcrumbs, including successful responses', async () => {
    const serverRequestId = '018f7c2a-6b4e-7a22-8e33-4c10b0010002';
    const fetch = jest
      .fn<Promise<Response>, Parameters<typeof globalThis.fetch>>()
      .mockResolvedValue(
        response({ status: 'ok' }, 200, 'application/json', { 'X-Request-Id': serverRequestId }),
      );
    const telemetry = { onRequest: jest.fn(), onResponse: jest.fn() };
    const client = createApiClient({
      baseUrl: 'https://api.example.invalid',
      appVersion: '1.2.3',
      platform: 'ios',
      fetch,
      session: {
        getAccessToken: jest.fn().mockResolvedValue(null),
        refreshSession: jest.fn().mockResolvedValue(null),
        signOutLocal: jest.fn().mockResolvedValue(undefined),
      },
      createRequestId: () => requestId,
      translate: (key) => key,
      telemetry,
    });
    const endpoint = { ...coreEndpoints[0], method: 'post' } as const;

    await client.request(endpoint, {
      body: { email: 'person@example.invalid', code: '123456', token: 'opaque-token' },
      headers: { 'X-Debug-Value': 'must-not-be-logged' },
    });

    expect(telemetry.onRequest).toHaveBeenCalledWith({ requestId, method: 'POST' });
    expect(telemetry.onResponse).toHaveBeenCalledWith({
      requestId,
      serverRequestId,
      status: 200,
    });
    const breadcrumbData = JSON.stringify([
      telemetry.onRequest.mock.calls,
      telemetry.onResponse.mock.calls,
    ]);
    expect(breadcrumbData).not.toContain('person@example.invalid');
    expect(breadcrumbData).not.toContain('123456');
    expect(breadcrumbData).not.toContain('opaque-token');
    expect(breadcrumbData).not.toContain('must-not-be-logged');
    expect(breadcrumbData).not.toContain('/v1/health');
  });

  it('omits malformed server correlation IDs and uses a valid server ID for contract mismatches', async () => {
    const malformedTelemetry = { onRequest: jest.fn(), onResponse: jest.fn() };
    const malformedClient = createApiClient({
      baseUrl: 'https://api.example.invalid',
      appVersion: '1.2.3',
      platform: 'ios',
      fetch: jest
        .fn<Promise<Response>, Parameters<typeof globalThis.fetch>>()
        .mockResolvedValue(
          response({ status: 'ok' }, 200, 'application/json', { 'X-Request-Id': 'not-a-uuid' }),
        ),
      session: {
        getAccessToken: jest.fn().mockResolvedValue(null),
        refreshSession: jest.fn().mockResolvedValue(null),
        signOutLocal: jest.fn().mockResolvedValue(undefined),
      },
      createRequestId: () => requestId,
      translate: (key) => key,
      telemetry: malformedTelemetry,
    });
    await malformedClient.request(coreEndpoints[0]);
    expect(malformedTelemetry.onResponse).toHaveBeenCalledWith({ requestId, status: 200 });

    const serverRequestId = '018f7c2a-6b4e-7a23-8e33-4c10b0010003';
    const onContractMismatch = jest.fn();
    const mismatchClient = createApiClient({
      baseUrl: 'https://api.example.invalid',
      appVersion: '1.2.3',
      platform: 'ios',
      fetch: jest
        .fn<Promise<Response>, Parameters<typeof globalThis.fetch>>()
        .mockResolvedValue(
          response({ status: 'unexpected' }, 200, 'application/json', {
            'X-Request-Id': serverRequestId,
          }),
        ),
      session: {
        getAccessToken: jest.fn().mockResolvedValue(null),
        refreshSession: jest.fn().mockResolvedValue(null),
        signOutLocal: jest.fn().mockResolvedValue(undefined),
      },
      createRequestId: () => requestId,
      translate: (key) => key,
      onContractMismatch,
    });

    await expect(mismatchClient.request(coreEndpoints[0])).rejects.toMatchObject({
      requestId: serverRequestId,
      code: 'client.contract_mismatch',
    });
    expect(onContractMismatch).toHaveBeenCalledWith({
      requestId: serverRequestId,
      path: '/v1/health',
    });
  });

  it('does not refresh or replay auth.recent_auth_required', async () => {
    const serverRequestId = '018f7c2a-6b4e-7a24-8e33-4c10b0010004';
    const recentAuthProblem = ProblemDetailsSchema.parse({
      type: 'about:blank',
      title: 'Recent authentication required',
      status: 401,
      code: 'auth.recent_auth_required',
      requestId: serverRequestId,
    });
    const fetch = jest
      .fn<Promise<Response>, Parameters<typeof globalThis.fetch>>()
      .mockResolvedValue(
        response(recentAuthProblem, 401, 'application/problem+json', {
          'X-Request-Id': serverRequestId,
        }),
      );
    const refreshSession = jest.fn().mockResolvedValue('new-token');
    const client = createApiClient({
      baseUrl: 'https://api.example.invalid',
      appVersion: '1.2.3',
      platform: 'ios',
      fetch,
      session: {
        getAccessToken: jest.fn().mockResolvedValue('old-token'),
        refreshSession,
        signOutLocal: jest.fn().mockResolvedValue(undefined),
      },
      createRequestId: () => requestId,
      translate: (key) => key,
    });

    await expect(client.request(privateHealthEndpoint)).rejects.toMatchObject({
      code: 'auth.recent_auth_required',
      requestId: serverRequestId,
    });
    expect(refreshSession).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retains the attempted request ID when every network attempt fails', async () => {
    const secondAttemptId = '018f7c2a-6b4e-7a25-8e33-4c10b0010005';
    const createRequestId = jest
      .fn()
      .mockReturnValueOnce(requestId)
      .mockReturnValueOnce(secondAttemptId);
    const fetch = jest
      .fn<Promise<Response>, Parameters<typeof globalThis.fetch>>()
      .mockRejectedValue(new Error('private transport detail'));
    const telemetry = { onRequest: jest.fn(), onResponse: jest.fn() };
    const client = createApiClient({
      baseUrl: 'https://api.example.invalid',
      appVersion: '1.2.3',
      platform: 'ios',
      fetch,
      session: {
        getAccessToken: jest.fn().mockResolvedValue(null),
        refreshSession: jest.fn().mockResolvedValue(null),
        signOutLocal: jest.fn().mockResolvedValue(undefined),
      },
      createRequestId,
      translate: (key) => key,
      telemetry,
      sleep: jest.fn().mockResolvedValue(undefined),
    });

    await expect(client.request(coreEndpoints[0])).rejects.toMatchObject({
      requestId: secondAttemptId,
      status: 0,
      code: null,
    });
    expect(createRequestId).toHaveBeenCalledTimes(2);
    expect(telemetry.onRequest.mock.calls).toEqual([
      [{ requestId, method: 'GET' }],
      [{ requestId: secondAttemptId, method: 'GET' }],
    ]);
    expect(telemetry.onResponse).not.toHaveBeenCalled();
  });

  it('sets request id, native app version, and platform headers on every request', async () => {
    const fetch = jest
      .fn<Promise<Response>, Parameters<typeof globalThis.fetch>>()
      .mockResolvedValue(response({ status: 'ok' }));
    const client = createApiClient({
      baseUrl: 'https://api.example.invalid',
      appVersion: '1.2.3',
      platform: 'ios',
      fetch,
      session: {
        getAccessToken: jest.fn().mockResolvedValue(null),
        refreshSession: jest.fn().mockResolvedValue(null),
        signOutLocal: jest.fn().mockResolvedValue(undefined),
      },
      createRequestId: () => requestId,
      translate: (key) => key,
    });

    await client.request(coreEndpoints[0]);

    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get('X-Request-Id')).toBe(requestId);
    expect(headers.get('X-App-Version')).toBe('1.2.3');
    expect(headers.get('X-Platform')).toBe('ios');
  });

  it('sends authorization only from the session port on private endpoints', async () => {
    const fetch = jest
      .fn<Promise<Response>, Parameters<typeof globalThis.fetch>>()
      .mockResolvedValue(response({ status: 'ok' }));
    const getAccessToken = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('private-access-token');
    const client = createApiClient({
      baseUrl: 'https://api.example.invalid',
      appVersion: '1.2.3',
      platform: 'android',
      fetch,
      session: {
        getAccessToken,
        refreshSession: jest.fn().mockResolvedValue(null),
        signOutLocal: jest.fn().mockResolvedValue(undefined),
      },
      createRequestId: () => requestId,
      translate: (key) => key,
    });

    await client.request(coreEndpoints[0], { headers: { Authorization: 'Bearer caller-token' } });
    await client.request(privateHealthEndpoint, {
      headers: { Authorization: 'Bearer caller-token' },
    });
    await client.request(privateHealthEndpoint);

    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has('Authorization')).toBe(false);
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).has('Authorization')).toBe(false);
    expect(new Headers(fetch.mock.calls[2]?.[1]?.headers).get('Authorization')).toBe(
      'Bearer private-access-token',
    );
  });

  it('shares a single session refresh across simultaneous 401 responses and repeats GET once', async () => {
    let resolveRefresh: ((value: string | null) => void) | undefined;
    const refreshPromise = new Promise<string | null>((resolve) => {
      resolveRefresh = resolve;
    });
    let unauthorizedCount = 0;
    let signalTwoUnauthorizedResponses: (() => void) | undefined;
    const twoUnauthorizedResponses = new Promise<void>((resolve) => {
      signalTwoUnauthorizedResponses = resolve;
    });
    let signalRefreshStarted: (() => void) | undefined;
    const refreshStarted = new Promise<void>((resolve) => {
      signalRefreshStarted = resolve;
    });
    const fetch = jest
      .fn<Promise<Response>, Parameters<typeof globalThis.fetch>>()
      .mockImplementation(async () => {
        unauthorizedCount += 1;
        if (unauthorizedCount === 2) signalTwoUnauthorizedResponses?.();
        return unauthorizedCount <= 2 ? response({}, 401) : response({ status: 'ok' });
      });
    const refreshSession = jest.fn(() => {
      signalRefreshStarted?.();
      return refreshPromise;
    });
    const client = createApiClient({
      baseUrl: 'https://api.example.invalid',
      appVersion: '1.2.3',
      platform: 'ios',
      fetch,
      session: {
        getAccessToken: jest.fn().mockResolvedValue('old-token'),
        refreshSession,
        signOutLocal: jest.fn().mockResolvedValue(undefined),
      },
      createRequestId: () => requestId,
      translate: (key) => key,
    });

    const pending = Promise.all([
      client.request(privateHealthEndpoint),
      client.request(privateHealthEndpoint),
    ]);
    await twoUnauthorizedResponses;
    await refreshStarted;
    expect(refreshSession).toHaveBeenCalledTimes(1);
    resolveRefresh?.('new-token');

    await expect(pending).resolves.toEqual([{ status: 'ok' }, { status: 'ok' }]);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('does not replay a non-idempotent request without an idempotency key', async () => {
    const fetch = jest
      .fn<Promise<Response>, Parameters<typeof globalThis.fetch>>()
      .mockResolvedValue(response({}, 401));
    const refreshSession = jest.fn().mockResolvedValue('new-token');
    const client = createApiClient({
      baseUrl: 'https://api.example.invalid',
      appVersion: '1.2.3',
      platform: 'ios',
      fetch,
      session: {
        getAccessToken: jest.fn().mockResolvedValue('old-token'),
        refreshSession,
        signOutLocal: jest.fn().mockResolvedValue(undefined),
      },
      createRequestId: () => requestId,
      translate: (key) => key,
    });
    const endpoint = { ...privateHealthEndpoint, method: 'post' } as const;

    await expect(client.request(endpoint, { body: { value: true } })).rejects.toBeInstanceOf(
      ApiRequestError,
    );
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('replays a POST only when it carries the same idempotency key', async () => {
    const fetch = jest
      .fn<Promise<Response>, Parameters<typeof globalThis.fetch>>()
      .mockResolvedValueOnce(response({}, 401))
      .mockResolvedValueOnce(response({ status: 'ok' }));
    const session = {
      getAccessToken: jest.fn().mockResolvedValue('old-token'),
      refreshSession: jest.fn().mockResolvedValue('new-token'),
      signOutLocal: jest.fn().mockResolvedValue(undefined),
    };
    const client = createApiClient({
      baseUrl: 'https://api.example.invalid',
      appVersion: '1.2.3',
      platform: 'ios',
      fetch,
      session,
      createRequestId: () => requestId,
      translate: (key) => key,
    });
    const endpoint = { ...privateHealthEndpoint, method: 'post' } as const;

    await expect(
      client.request(endpoint, { body: { value: true }, idempotencyKey: 'operation-1' }),
    ).resolves.toEqual({ status: 'ok' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('Idempotency-Key')).toBe(
      'operation-1',
    );
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get('Idempotency-Key')).toBe(
      'operation-1',
    );
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get('Authorization')).toBe(
      'Bearer new-token',
    );
  });

  it('signs out after the single replay also returns 401', async () => {
    const fetch = jest
      .fn<Promise<Response>, Parameters<typeof globalThis.fetch>>()
      .mockResolvedValue(response({}, 401));
    const signOutLocal = jest.fn().mockResolvedValue(undefined);
    const client = createApiClient({
      baseUrl: 'https://api.example.invalid',
      appVersion: '1.2.3',
      platform: 'ios',
      fetch,
      session: {
        getAccessToken: jest.fn().mockResolvedValue('old-token'),
        refreshSession: jest.fn().mockResolvedValue('new-token'),
        signOutLocal,
      },
      createRequestId: () => requestId,
      translate: (key) => key,
    });

    await expect(client.request(privateHealthEndpoint)).rejects.toBeInstanceOf(ApiRequestError);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(signOutLocal).toHaveBeenCalledTimes(1);
  });

  it('uses two total GET attempts and preserves an API base path prefix', async () => {
    const fetch = jest
      .fn<Promise<Response>, Parameters<typeof globalThis.fetch>>()
      .mockResolvedValueOnce(response({ error: true }, 503))
      .mockResolvedValueOnce(response({ status: 'ok' }));
    const client = createApiClient({
      baseUrl: 'https://api.example.invalid/gateway',
      appVersion: '1.2.3',
      platform: 'ios',
      fetch,
      session: {
        getAccessToken: jest.fn().mockResolvedValue(null),
        refreshSession: jest.fn().mockResolvedValue(null),
        signOutLocal: jest.fn().mockResolvedValue(undefined),
      },
      createRequestId: () => requestId,
      translate: (key) => key,
      sleep: jest.fn().mockResolvedValue(undefined),
      random: () => 0,
    });

    await expect(client.request(coreEndpoints[0])).resolves.toEqual({ status: 'ok' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.example.invalid/gateway/v1/health');
    expect(fetch.mock.calls[1]?.[0]).toBe('https://api.example.invalid/gateway/v1/health');
  });

  it('translates problem details and hides raw technical details', async () => {
    const problem = ProblemDetailsSchema.parse({
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      code: 'auth.token_expired',
      requestId,
      detail: 'sensitive backend detail',
    });
    const fetch = jest
      .fn<Promise<Response>, Parameters<typeof globalThis.fetch>>()
      .mockResolvedValue(response(problem, 401, 'application/problem+json'));
    const client = createApiClient({
      baseUrl: 'https://api.example.invalid',
      appVersion: '1.2.3',
      platform: 'ios',
      fetch,
      session: {
        getAccessToken: jest.fn().mockResolvedValue(null),
        refreshSession: jest.fn().mockResolvedValue(null),
        signOutLocal: jest.fn().mockResolvedValue(undefined),
      },
      createRequestId: () => requestId,
      translate: (key) =>
        key === 'errors.auth.token_expired' ? 'Session expired' : 'Request failed',
    });

    await expect(client.request(coreEndpoints[0])).rejects.toMatchObject({
      message: 'Session expired',
      requestId,
      code: 'auth.token_expired',
    });
  });

  it.each([
    ['pt-BR', 'Ocorreu um erro inesperado.'],
    ['en', 'An unexpected error occurred.'],
    ['es', 'Ocurrió un error inesperado.'],
  ] as const)(
    'uses a localized generic message and request ID for an unknown code in %s',
    async (locale, expectedMessage) => {
      setActiveMobileI18n(createMobileI18n(locale));
      const problem = ProblemDetailsSchema.parse({
        type: 'about:blank',
        title: 'Unexpected error',
        status: 400,
        code: 'vendor.unrecognized_failure',
        requestId,
      });
      const client = createApiClient({
        baseUrl: 'https://api.example.invalid',
        appVersion: '1.2.3',
        platform: 'ios',
        fetch: jest
          .fn<Promise<Response>, Parameters<typeof globalThis.fetch>>()
          .mockResolvedValue(response(problem, 400, 'application/problem+json')),
        session: {
          getAccessToken: jest.fn().mockResolvedValue(null),
          refreshSession: jest.fn().mockResolvedValue(null),
          signOutLocal: jest.fn().mockResolvedValue(undefined),
        },
        createRequestId: () => requestId,
        translate: translateMobile,
      });

      const error = await client.request(coreEndpoints[0]).catch((value: unknown) => value);
      expect(error).toMatchObject({ requestId, code: 'vendor.unrecognized_failure' });
      expect((error as Error).message).toContain(expectedMessage);
      expect((error as Error).message).toContain(requestId);
      expect((error as Error).message).not.toContain('vendor.unrecognized_failure');
    },
  );

  it('keeps the timeout active until a successful response body is read', async () => {
    jest.useFakeTimers();
    try {
      const fetch = jest
        .fn<Promise<Response>, Parameters<typeof globalThis.fetch>>()
        .mockImplementation(
          async (_input, init) =>
            ({
              ok: true,
              status: 200,
              headers: new Headers({ 'content-type': 'application/json' }),
              body: null,
              json: () =>
                new Promise((_resolve, reject) => {
                  init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
                    once: true,
                  });
                }),
            }) as Response,
        );
      const client = createApiClient({
        baseUrl: 'https://api.example.invalid',
        appVersion: '1.2.3',
        platform: 'ios',
        fetch,
        session: {
          getAccessToken: jest.fn().mockResolvedValue(null),
          refreshSession: jest.fn().mockResolvedValue(null),
          signOutLocal: jest.fn().mockResolvedValue(undefined),
        },
        createRequestId: () => requestId,
        translate: (key) => key,
        timeoutMs: 10,
        sleep: jest.fn().mockResolvedValue(undefined),
      });

      const pending = client.request(coreEndpoints[0]);
      const rejection = expect(pending).rejects.toMatchObject({
        status: 0,
        code: null,
        translationKey: 'errors.generic',
      });
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(20);
      await rejection;
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
