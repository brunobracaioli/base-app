import type { NormalizedProfilePatch, UserProfile } from './user-profile';

export type ConsentDocument = 'terms' | 'privacy';

export type ConsentStatus = {
  readonly needsAcceptance: readonly ConsentDocument[];
};

export interface ProfileRepository {
  ensureProfile(input: {
    readonly userId: string;
    readonly initialLocale: string;
  }): Promise<UserProfile>;
  updateProfile(input: {
    readonly userId: string;
    readonly changes: NormalizedProfilePatch;
  }): Promise<UserProfile>;
}

export interface ConsentStatusReader {
  getStatus(userId: string): Promise<ConsentStatus>;
}
