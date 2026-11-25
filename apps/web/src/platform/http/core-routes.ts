import { AppConfigResponse, coreEndpoints, ConsentBody, Me, UpdateProfileBody } from '@base-app/contracts';
import type { AppConfigResponseValue, MeResponse } from '@base-app/contracts';
import * as z from 'zod';

import { ConsentVersionOutdatedError } from '../../modules/privacy';
import { InvalidProfileUpdateError, ProfileOwnerMissingError } from '../../modules/identity';
import type { ProfilePatch } from '../../modules/identity';
import { getProfileLocaleHint } from '../auth';
import type { AuthContext, UserAuthContext } from '../authorization/types';
import type { CoreComposition } from '../composition/core';
import { getCoreRuntime, getSafeAppConfigRuntime } from '../composition/core';
import type { DefineRouteInput } from './types';
import { HttpProblem } from './problem';

function findEndpoint(operationId: string) {
  const endpoint = coreEndpoints.find((candidate) => candidate.operationId === operationId);
  if (!endpoint) throw new Error(`Missing core endpoint contract: ${operationId}`);
  return endpoint;
}

const getAppConfigContract = findEndpoint('getAppConfig');
const getMeContract = findEndpoint('getMe');
const updateMeContract = findEndpoint('updateMe');
const acceptConsentContract = findEndpoint('acceptConsent');

function toMeResponse(snapshot: Awaited<ReturnType<CoreComposition['getMe']>>): MeResponse {
  return Me.parse({
    id: snapshot.profile.userId,
    email: snapshot.email,
    displayName: snapshot.profile.displayName,
    locale: snapshot.profile.locale,
    createdAt: snapshot.profile.createdAt.toISOString(),
    consents: snapshot.consents,
  });
}

function routeProblem(error: unknown): never {
  if (error instanceof ProfileOwnerMissingError) {
    throw new HttpProblem(401, 'auth.account_deleted', 'Authentication failed.');
  }
  if (error instanceof InvalidProfileUpdateError) {
    throw new HttpProblem(400, 'validation.failed', 'Request validation failed.');
  }
  if (error instanceof ConsentVersionOutdatedError) {
    throw new HttpProblem(
      409,
      'privacy.consent_version_outdated',
      'The legal document version is no longer current.',
    );
  }
  throw error;
}

function userAuth(auth: AuthContext | null): UserAuthContext {
  if (auth?.kind !== 'user') {
    throw new HttpProblem(401, 'auth.required', 'Authentication is required.');
  }
  return auth;
}

type UpdateMeInput = { readonly body: typeof UpdateProfileBody };
type AcceptConsentInput = { readonly body: typeof ConsentBody };

export function createCoreRouteDefinitions(
  getRuntime: () => CoreComposition,
  getPublicAppConfig: () => Promise<AppConfigResponseValue> = () =>
    getSafeAppConfigRuntime().getPublicAppConfig(),
) {
  const getAppConfig: DefineRouteInput<Record<never, never>, AppConfigResponseValue> = {
    operationId: getAppConfigContract.operationId,
    auth: { kind: 'public' },
    rateLimit: getAppConfigContract.rateLimit,
    successStatus: 200,
    cachePolicy: 'public-app-config',
    output: AppConfigResponse,
    async handler() {
      return getPublicAppConfig();
    },
  };

  const getMe: DefineRouteInput<Record<never, never>, MeResponse> = {
    operationId: getMeContract.operationId,
    auth: { kind: 'user' },
    rateLimit: getMeContract.rateLimit,
    successStatus: 200,
    output: Me,
    async handler(context) {
      const auth = userAuth(context.auth);
      try {
        return toMeResponse(
          await getRuntime().getMe({
            auth,
            profileLocaleHint: getProfileLocaleHint(auth),
            correlationId: context.correlationId,
          }),
        );
      } catch (error) {
        return routeProblem(error);
      }
    },
  };

  const updateMe: DefineRouteInput<UpdateMeInput, MeResponse> = {
    operationId: updateMeContract.operationId,
    auth: { kind: 'user' },
    rateLimit: updateMeContract.rateLimit,
    successStatus: 200,
    input: { body: UpdateProfileBody },
    output: Me,
    async handler(context) {
      const auth = userAuth(context.auth);
      try {
        return toMeResponse(
          await getRuntime().updateMe({
            auth,
            profileLocaleHint: getProfileLocaleHint(auth),
            correlationId: context.correlationId,
            patch: {
              ...(context.input.body.displayName !== undefined
                ? { displayName: context.input.body.displayName }
                : {}),
              ...(context.input.body.locale !== undefined
                ? { locale: context.input.body.locale }
                : {}),
            } satisfies ProfilePatch,
          }),
        );
      } catch (error) {
        return routeProblem(error);
      }
    },
  };

  const acceptConsent: DefineRouteInput<AcceptConsentInput, undefined> = {
    operationId: acceptConsentContract.operationId,
    auth: { kind: 'user' },
    rateLimit: acceptConsentContract.rateLimit,
    successStatus: 204,
    input: { body: ConsentBody },
    output: z.undefined(),
    async handler(context) {
      const auth = userAuth(context.auth);
      try {
        await getRuntime().acceptConsent({
          auth,
          profileLocaleHint: getProfileLocaleHint(auth),
          correlationId: context.correlationId,
          document: context.input.body.document,
          version: context.input.body.version,
        });
        return undefined;
      } catch (error) {
        return routeProblem(error);
      }
    },
  };

  return Object.freeze({ getAppConfig, getMe, updateMe, acceptConsent });
}

export const coreRouteDefinitions = createCoreRouteDefinitions(
  () => getCoreRuntime(),
  () => getSafeAppConfigRuntime().getPublicAppConfig(),
);
