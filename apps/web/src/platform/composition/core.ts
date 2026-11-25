import productConfig from '@base-app/config/product.config';
import type { ProductConfig } from '@base-app/config';

import {
  createFreshRolesReader,
  createIdentityUseCases,
  createProfileRepository,
  type ProfilePatch,
  type MeSnapshot,
  type UpdatedMeSnapshot,
} from '../../modules/identity';
import {
  createConsentRepository,
  createPrivacyUseCases,
  type ConsentDocument,
} from '../../modules/privacy';
import { createLegalVersionsReader } from '../../modules/app-config';
import type { UserAuthContext } from '../authorization/types';
import { createDatabase } from '../db';
import type { DbClaims } from '../db';
import { requireDatabaseEnvironment, parseServerEnv } from '../env';
import type { AppLogger } from '../observability/logger';
import { createLogger } from '../observability/logger';
import { serverExtensionComposition } from './index';

type CoreDatabase = ReturnType<typeof createDatabase>;

export type CoreUserRequest = {
  readonly auth: UserAuthContext;
  readonly profileLocaleHint: string | undefined;
  readonly correlationId: string;
};

export type CoreUpdateProfileRequest = CoreUserRequest & {
  readonly patch: ProfilePatch;
};

export type CoreAcceptConsentRequest = CoreUserRequest & {
  readonly document: ConsentDocument;
  readonly version: string;
};

function errorFields(error: unknown): {
  readonly errorName: string;
  readonly sqlState?: string;
} {
  const errorName =
    typeof error === 'object' && error !== null && 'name' in error && typeof error.name === 'string'
      ? error.name
      : 'Error';
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined;
  return {
    errorName,
    ...(code && /^[0-9A-Z]{5}$/.test(code) ? { sqlState: code } : {}),
  };
}

function assertVerifiedScope(auth: UserAuthContext): DbClaims {
  if (auth.userId !== auth.dbClaims.sub) {
    throw new TypeError('Verified user does not match database claims.');
  }
  return auth.dbClaims;
}

export function createCoreComposition(input: {
  readonly database: CoreDatabase;
  readonly logger: AppLogger;
  readonly product?: ProductConfig;
  readonly now?: () => Date;
}) {
  const product = input.product ?? productConfig;
  const clock = { now: input.now ?? (() => new Date()) };
  const legalVersions = createLegalVersionsReader(input.database);
  const readFreshRoles = createFreshRolesReader(input.database, input.logger);

  function forUser(auth: UserAuthContext) {
    const dbClaims = assertVerifiedScope(auth);
    const profiles = createProfileRepository({
      database: input.database,
      dbClaims,
      supportedLocales: product.locales,
    });
    const consents = createConsentRepository({ database: input.database, dbClaims });
    const privacy = createPrivacyUseCases({ consents, legalVersions, clock });
    const identity = createIdentityUseCases({
      profiles,
      consentStatus: { getStatus: privacy.getConsentStatus },
      supportedLocales: product.locales,
      defaultLocale: product.defaultLocale,
    });
    return { identity, privacy };
  }

  async function diagnose<T>(
    operation: 'getMe' | 'updateMe' | 'acceptConsent',
    correlationId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      return await work();
    } catch (error) {
      input.logger.error('Core user operation failed.', {
        operation,
        correlationId,
        ...errorFields(error),
      });
      throw error;
    }
  }

  return Object.freeze({
    getMe(request: CoreUserRequest): Promise<MeSnapshot> {
      return diagnose('getMe', request.correlationId, async () => {
        const { identity } = forUser(request.auth);
        return identity.getMe({
          userId: request.auth.dbClaims.sub,
          email: request.auth.email,
          profileLocaleHint: request.profileLocaleHint,
        });
      });
    },

    updateMe(request: CoreUpdateProfileRequest): Promise<UpdatedMeSnapshot> {
      return diagnose('updateMe', request.correlationId, async () => {
        const { identity } = forUser(request.auth);
        return identity.updateProfile({
          userId: request.auth.dbClaims.sub,
          email: request.auth.email,
          profileLocaleHint: request.profileLocaleHint,
          patch: request.patch,
        });
      });
    },

    acceptConsent(request: CoreAcceptConsentRequest): Promise<void> {
      return diagnose('acceptConsent', request.correlationId, async () => {
        const { privacy } = forUser(request.auth);
        await privacy.acceptConsent({
          userId: request.auth.dbClaims.sub,
          document: request.document,
          version: request.version,
        });
      });
    },

    loadFreshRoles(auth: UserAuthContext): Promise<readonly string[]> {
      return readFreshRoles(auth);
    },
  });
}

export type CoreComposition = ReturnType<typeof createCoreComposition>;

let coreRuntime: CoreComposition | undefined;

/**
 * Environment and database setup is deferred until a core user route or fresh
 * authorization check calls this function. Build and health stay credential-free.
 */
export function getCoreRuntime(): CoreComposition {
  if (coreRuntime) return coreRuntime;
  const environment = requireDatabaseEnvironment(parseServerEnv());
  const logger = createLogger();
  const database = createDatabase(environment, {
    extensionSystemRoles: serverExtensionComposition.extensionSystemRoles,
    logger,
  });
  coreRuntime = createCoreComposition({ database, logger });
  return coreRuntime;
}
