import type { AppConfigResponseValue } from '@base-app/contracts';

import { createApiClient, type ApiClient } from '../../../shared/api-client/api-client';
import { createAppConfigReader } from './app-config-reader';

const validConfig: AppConfigResponseValue = {
  versions: {
    ios: {
      minSupported: '1.0.0',
      latest: '1.1.0',
      storeUrl: 'https://apps.apple.com/app/id0000000000',
    },
    android: {
      minSupported: '1.0.0',
      latest: '1.1.0',
      storeUrl: 'https://play.google.com/store/apps/details?id=com.example.myapp',
    },
  },
  maintenance: {
    active: false,
    platforms: ['ios', 'android'],
    messageKey: 'maintenance.default',
    until: null,
  },
  legal: {
    termsVersion: '2026-01-01',
    privacyVersion: '2026-01-01',
    termsUrl: 'https://myapp.example.invalid/terms',
    privacyUrl: 'https://myapp.example.invalid/privacy',
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: { cancel: jest.fn().mockResolvedValue(undefined) },
    json: async () => body,
    clone() {
      return jsonResponse(body, status);
    },
  } as unknown as Response;
}

function makeClient(
  fetch: typeof globalThis.fetch,
  onContractMismatch = jest.fn(),
  createRequestId = () => '018f7c2a-6b4e-7a21-8e33-4c10b0010001',
) {
  const session = {
    getAccessToken: jest.fn().mockResolvedValue('must-not-be-used-for-public-config'),
    refreshSession: jest.fn().mockResolvedValue(null),
    signOutLocal: jest.fn().mockResolvedValue(undefined),
  };
  const client: ApiClient = createApiClient({
    baseUrl: 'https://api.example.invalid',
    appVersion: '1.2.3',
    platform: 'ios',
    fetch,
    session,
    createRequestId,
    translate: (key) => key,
    random: () => 0,
    onContractMismatch,
  });
  return { client, session, onContractMismatch };
}

describe('createAppConfigReader', () => {
  it('uses the typed public endpoint without asking for or sending an access token', async () => {
    const fetch = jest
      .fn<Promise<Response>, Parameters<typeof globalThis.fetch>>()
      .mockResolvedValue(jsonResponse(validConfig));
    const { client, session } = makeClient(fetch);
    const reader = createAppConfigReader(client);

    await expect(reader()).resolves.toEqual(validConfig);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.example.invalid/v1/app-config');
    const request = fetch.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(request.headers);
    expect(headers.get('Authorization')).toBeNull();
    expect(headers.get('X-Request-Id')).toBe('018f7c2a-6b4e-7a21-8e33-4c10b0010001');
    expect(headers.get('X-App-Version')).toBe('1.2.3');
    expect(headers.get('X-Platform')).toBe('ios');
    expect(session.getAccessToken).not.toHaveBeenCalled();
  });

  it('reports an invalid response through the shared client contract mismatch path', async () => {
    const fetch = jest
      .fn<Promise<Response>, Parameters<typeof globalThis.fetch>>()
      .mockResolvedValue(jsonResponse({ ...validConfig, extra: 'not allowed' }));
    const { client, onContractMismatch } = makeClient(fetch);
    const reader = createAppConfigReader(client);

    await expect(reader()).rejects.toMatchObject({ code: 'client.contract_mismatch' });
    expect(onContractMismatch).toHaveBeenCalledWith({
      requestId: '018f7c2a-6b4e-7a21-8e33-4c10b0010001',
      path: '/v1/app-config',
    });
  });

  it('does not retry non-retryable public responses', async () => {
    const fetch = jest
      .fn<Promise<Response>, Parameters<typeof globalThis.fetch>>()
      .mockResolvedValue(jsonResponse({}, 404));
    const { client } = makeClient(fetch);

    await expect(createAppConfigReader(client)()).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('bounds retries, backoff, and response work to one three-second deadline', async () => {
    jest.useFakeTimers();
    try {
      const fetch = jest
        .fn<Promise<Response>, Parameters<typeof globalThis.fetch>>()
        .mockResolvedValueOnce(jsonResponse({}, 503))
        .mockImplementationOnce((_input, init) => {
          const signal = init?.signal;
          return new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        });
      const requestIds = jest
        .fn()
        .mockReturnValueOnce('018f7c2a-6b4e-7a21-8e33-4c10b0010001')
        .mockReturnValueOnce('018f7c2a-6b4e-7a22-8e33-4c10b0010002');
      const { client } = makeClient(fetch, jest.fn(), requestIds);
      const pending = createAppConfigReader(client)();
      const outcome = pending.catch((error: unknown) => error);

      await jest.advanceTimersByTimeAsync(3_000);
      const error = await outcome;
      expect(fetch).toHaveBeenCalledTimes(2);
      const request = fetch.mock.calls[1]?.[1] as RequestInit;
      const requestId = new Headers(request.headers).get('X-Request-Id');
      expect(request.signal?.aborted).toBe(true);
      expect(error).toMatchObject({ status: 0, requestId });
      expect(requestId).toBe('018f7c2a-6b4e-7a22-8e33-4c10b0010002');
      expect(requestIds).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
