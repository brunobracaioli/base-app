import type { ConsentStatusReader, ProfileRepository } from '../../../domain/profile-ports';
import {
  resolveInitialLocale,
  type ProfilePatch,
  type UserProfile,
} from '../../../domain/user-profile';

export type UpdateProfileInput = {
  readonly userId: string;
  readonly email: string | null;
  readonly profileLocaleHint: string | undefined;
  readonly patch: ProfilePatch;
};

export type UpdatedMeSnapshot = {
  readonly profile: UserProfile;
  readonly email: string | null;
  readonly consents: Awaited<ReturnType<ConsentStatusReader['getStatus']>>;
};

export function createUpdateProfile(input: {
  readonly profiles: ProfileRepository;
  readonly consentStatus: ConsentStatusReader;
  readonly supportedLocales: readonly string[];
  readonly defaultLocale: string;
}): (command: UpdateProfileInput) => Promise<UpdatedMeSnapshot> {
  return async (command) => {
    const initialLocale = resolveInitialLocale(
      command.profileLocaleHint,
      input.supportedLocales,
      input.defaultLocale,
    );
    const currentProfile = await input.profiles.ensureProfile({
      userId: command.userId,
      initialLocale,
    });
    const update = currentProfile.update(command.patch);
    const profile = await input.profiles.updateProfile({
      userId: command.userId,
      changes: update.changes,
    });
    const consents = await input.consentStatus.getStatus(command.userId);

    return { profile, email: command.email, consents };
  };
}
