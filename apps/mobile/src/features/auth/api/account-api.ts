import {
  ConsentBody,
  Me,
  UpdateProfileBody,
  coreEndpoints,
  type ConsentBodyInput,
  type MeResponse,
  type UpdateProfileBodyInput,
} from '@base-app/contracts';
import * as z from 'zod';

import { ApiRequestError, apiClient } from '../../../shared/api-client';
import type { ApiClient, ApiEndpoint } from '../../../shared/api-client';
import type { AuthErrorKey, Result } from '../../../extensions/types';
import type { AccountApiPort } from '../model/auth-contracts';

function makeEndpoint<T>(operationId: string, responseSchema: z.ZodType<T>): ApiEndpoint<T> {
  const contract = coreEndpoints.find((endpoint) => endpoint.operationId === operationId);
  if (contract === undefined || contract.security.length === 0) {
    throw new Error(`The ${operationId} endpoint contract is unavailable.`);
  }

  return {
    method: contract.method,
    path: contract.path,
    security: contract.security,
    successStatus: contract.successStatus,
    responseSchema,
  };
}

const getMeEndpoint = makeEndpoint<MeResponse>('getMe', Me);
const updateMeEndpoint = makeEndpoint<MeResponse>('updateMe', Me);
const acceptConsentEndpoint = makeEndpoint<void>('acceptConsent', z.undefined());

function failureFrom(error: unknown): AuthErrorKey {
  if (error instanceof ApiRequestError && error.status === 401) {
    return 'auth.session_expired';
  }
  return 'auth.failed';
}

async function capture<T>(call: () => Promise<T>): Promise<Result<T, AuthErrorKey>> {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    return { ok: false, error: failureFrom(error) };
  }
}

/** Uses the app's shared API client; the injectable client exists only for deterministic tests. */
export function createAccountApi(client: ApiClient = apiClient): AccountApiPort {
  return {
    getMe: () => capture(() => client.request(getMeEndpoint)),
    updateMe: (input: UpdateProfileBodyInput) =>
      capture(() => client.request(updateMeEndpoint, { body: UpdateProfileBody.parse(input) })),
    acceptConsent: (input: ConsentBodyInput) =>
      capture(() => client.request(acceptConsentEndpoint, { body: ConsentBody.parse(input) })),
  };
}

export const accountApi: AccountApiPort = createAccountApi();
