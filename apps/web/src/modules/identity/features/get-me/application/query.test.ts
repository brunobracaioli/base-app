import { describe, expect, it } from 'vitest';

import { createGetMe } from './query';
import { UserProfile } from '../../../domain/user-profile';
import type { ConsentStatusReader, ProfileRepository } from '../../../domain/profile-ports';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CREATED_AT = new Date('2026-11-25T12:00:00.000Z');

function profileRepository(): ProfileRepository & { readonly ensures: unknown[] } {
  const ensures: unknown[] = [];
  return {
    ensures,
    async ensureProfile(input) {
      ensures.push(input);
      return UserProfile.restore(
        {
          userId: input.userId,
          displayName: null,
          locale: input.initialLocale,
          createdAt: CREATED_AT,
        },
        ['pt-BR', 'en', 'es'],
      );
    },
    async updateProfile() {
      throw new Error('GET must not update a profile.');
    },
  };
}

describe('getMe use case', () => {
  it('creates the profile with the allowlisted private locale hint and returns consent status', async () => {
    const profiles = profileRepository();
    const statuses: string[] = [];
    const consentStatus: ConsentStatusReader = {
      async getStatus(userId) {
        statuses.push(userId);
        return { needsAcceptance: ['terms'] };
      },
    };
    const getMe = createGetMe({
      profiles,
      consentStatus,
      supportedLocales: ['pt-BR', 'en', 'es'],
      defaultLocale: 'pt-BR',
    });

    const first = await getMe({
      userId: USER_ID,
      email: 'person@example.test',
      profileLocaleHint: 'es',
    });
    const second = await getMe({
      userId: USER_ID,
      email: null,
      profileLocaleHint: 'fr',
    });

    expect(profiles.ensures).toEqual([
      { userId: USER_ID, initialLocale: 'es' },
      { userId: USER_ID, initialLocale: 'pt-BR' },
    ]);
    expect(first.profile.locale).toBe('es');
    expect(first.email).toBe('person@example.test');
    expect(second.email).toBeNull();
    expect(first.consents.needsAcceptance).toEqual(['terms']);
    expect(statuses).toEqual([USER_ID, USER_ID]);
  });
});
