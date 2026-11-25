import type { ConsentStatusReader, ProfileRepository } from './domain/profile-ports';
import { createGetMe } from './features/get-me/application/query';
import { createUpdateProfile } from './features/update-profile/application/command';

export function createIdentityUseCases(input: {
  readonly profiles: ProfileRepository;
  readonly consentStatus: ConsentStatusReader;
  readonly supportedLocales: readonly string[];
  readonly defaultLocale: string;
}) {
  return Object.freeze({
    getMe: createGetMe(input),
    updateProfile: createUpdateProfile(input),
  });
}

export { createFreshRolesReader } from './infrastructure/fresh-roles-reader';
export { createIdentityPurgeHandler } from './infrastructure/purge-handler';
export { createProfileRepository } from './infrastructure/profile-repository';
export { ProfileOwnerMissingError } from './domain/profile-owner-missing';
export {
  InvalidProfileUpdateError,
  InvalidUserProfileError,
  UserProfile,
  normalizeDisplayName,
  resolveInitialLocale,
} from './domain/user-profile';
export type {
  ConsentDocument,
  ConsentStatus,
  ConsentStatusReader,
  ProfileRepository,
} from './domain/profile-ports';
export type {
  NormalizedProfilePatch,
  ProfilePatch,
  UserProfileSnapshot,
} from './domain/user-profile';
export type { GetMeInput, MeSnapshot } from './features/get-me/application/query';
export type {
  UpdateProfileInput,
  UpdatedMeSnapshot,
} from './features/update-profile/application/command';
