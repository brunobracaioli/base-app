import {
  ConsentBody,
  Me,
  UpdateProfileBody,
  coreEndpoints,
  type MeResponse,
} from '@base-app/contracts';

import { ApiRequestError, type ApiClient, type ApiEndpoint } from '../../../shared/api-client';
import { createAccountApi } from './account-api';

jest.mock('../../../shared/api-client', () => {
  class ApiRequestError extends Error {
    constructor(
      message: string,
      status: number,
      requestId: string,
      code: string | null,
      translationKey: string,
    ) {
      super(message);
      Object.assign(this, { status, requestId, code, translationKey });
    }
  }
  return { ApiRequestError, apiClient: { request: jest.fn() } };
});

const validMe: MeResponse = {
  id: '123e4567-e89b-42d3-a456-426614174000',
  email: 'person@example.com',
  displayName: 'Person',
  locale: 'en',
  createdAt: '2026-11-26T00:00:00.000Z',
  consents: { needsAcceptance: ['terms'] },
};

describe('account API', () => {
  it('uses only existing me and consent endpoints with their validated response contracts', async () => {
    const request = jest.fn(async (endpoint: ApiEndpoint<unknown>) => {
      if (endpoint.path === '/v1/me') return validMe;
      return undefined;
    });
    const api = createAccountApi({ request } as ApiClient);

    expect(await api.getMe()).toEqual({ ok: true, value: validMe });
    expect(await api.updateMe({ displayName: 'Ana' })).toEqual({ ok: true, value: validMe });
    expect(await api.acceptConsent({ document: 'terms', version: '2026-11-24' })).toEqual({
      ok: true,
      value: undefined,
    });

    expect(request.mock.calls.map(([endpoint]) => endpoint.path)).toEqual([
      '/v1/me',
      '/v1/me',
      '/v1/me/consents',
    ]);
    expect(coreEndpoints.some(({ operationId }) => operationId === 'getMe')).toBe(true);
    expect(coreEndpoints.some(({ operationId }) => operationId === 'updateMe')).toBe(true);
    expect(coreEndpoints.some(({ operationId }) => operationId === 'acceptConsent')).toBe(true);
    expect(Me.parse(validMe)).toEqual(validMe);
    expect(UpdateProfileBody.parse({ displayName: ' Ana ' })).toEqual({ displayName: 'Ana' });
    expect(ConsentBody.parse({ document: 'terms', version: '2026-11-24' })).toEqual({
      document: 'terms',
      version: '2026-11-24',
    });
  });

  it('validates write bodies before calling the shared client', async () => {
    const request = jest.fn(async () => validMe);
    const api = createAccountApi({ request } as unknown as ApiClient);

    expect(await api.updateMe({ displayName: '   ' })).toEqual({
      ok: false,
      error: 'auth.failed',
    });
    expect(await api.acceptConsent({ document: 'terms', version: '2026-2-4' })).toEqual({
      ok: false,
      error: 'auth.failed',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('maps request failures to stable generic auth errors', async () => {
    const unauthorized = new ApiRequestError('private details', 401, 'request-id', 'x', 'auth');
    const failed = new ApiRequestError('private details', 500, 'request-id', 'x', 'server');
    const api = createAccountApi({
      request: jest
        .fn<Promise<MeResponse>, [ApiEndpoint<unknown>]>()
        .mockRejectedValueOnce(unauthorized)
        .mockRejectedValueOnce(failed),
    } as unknown as ApiClient);

    expect(await api.getMe()).toEqual({ ok: false, error: 'auth.session_expired' });
    expect(await api.getMe()).toEqual({ ok: false, error: 'auth.failed' });
  });
});
