import type { ConsentStatusReader, ProfileRepository } from '../../../domain/profile-ports';
import { resolveInitialLocale, type UserProfile } from '../../../domain/user-profile';

export type GetMeInput = {
  readonly userId: string;
  readonly email: string | null;
  readonly profileLocaleHint: string | undefined;
};

export type MeSnapshot = {
  readonly profile: UserProfile;
  readonly email: string | null;
  readonly consents: Awaited<ReturnType<ConsentStatusReader['getStatus']>>;
};

export function createGetMe(input: {
  readonly profiles: ProfileRepository;
  readonly consentStatus: ConsentStatusReader;
  readonly supportedLocales: readonly string[];
  readonly defaultLocale: string;
}): (query: GetMeInput) => Promise<MeSnapshot> {
  return async (query) => {
    const initialLocale = resolveInitialLocale(
      query.profileLocaleHint,
      input.supportedLocales,
      input.defaultLocale,
    );
    const profile = await input.profiles.ensureProfile({
      userId: query.userId,
      initialLocale,
    });
    const consents = await input.consentStatus.getStatus(query.userId);

    return { profile, email: query.email, consents };
  };
}
