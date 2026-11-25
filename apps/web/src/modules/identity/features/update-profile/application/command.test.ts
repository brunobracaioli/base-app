import { describe, expect, it } from 'vitest';

import { createUpdateProfile } from './command';
import { UserProfile } from '../../../domain/user-profile';
import type { ConsentStatusReader, ProfileRepository } from '../../../domain/profile-ports';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CREATED_AT = new Date('2026-11-25T12:00:00.000Z');

describe('updateProfile use case', () => {
  it('normalizes the requested field and sends only present fields to persistence', async () => {
    const updates: unknown[] = [];
    const profiles: ProfileRepository = {
      async ensureProfile() {
        return UserProfile.restore(
          { userId: USER_ID, displayName: 'Ana', locale: 'pt-BR', createdAt: CREATED_AT },
          ['pt-BR', 'en', 'es'],
        );
      },
      async updateProfile(input) {
        updates.push(input);
        return UserProfile.restore(
          { userId: input.userId, displayName: 'Ána', locale: 'pt-BR', createdAt: CREATED_AT },
          ['pt-BR', 'en', 'es'],
        );
      },
    };
    const consentStatus: ConsentStatusReader = {
      async getStatus() {
        return { needsAcceptance: ['privacy'] };
      },
    };
    const updateProfile = createUpdateProfile({
      profiles,
      consentStatus,
      supportedLocales: ['pt-BR', 'en', 'es'],
      defaultLocale: 'pt-BR',
    });

    const result = await updateProfile({
      userId: USER_ID,
      email: 'person@example.test',
      profileLocaleHint: 'es',
      patch: { displayName: '  A\u0301na\u0000  ' },
    });

    expect(updates).toEqual([{ userId: USER_ID, changes: { displayName: 'Ána' } }]);
    expect(result.profile.displayName).toBe('Ána');
    expect(result.profile.locale).toBe('pt-BR');
    expect(result.email).toBe('person@example.test');
    expect(result.consents.needsAcceptance).toEqual(['privacy']);
  });

  it('does not write when normalized profile data is invalid', async () => {
    let writes = 0;
    const profiles: ProfileRepository = {
      async ensureProfile() {
        return UserProfile.restore(
          { userId: USER_ID, displayName: null, locale: 'pt-BR', createdAt: CREATED_AT },
          ['pt-BR', 'en', 'es'],
        );
      },
      async updateProfile() {
        writes += 1;
        throw new Error('invalid data must not reach persistence');
      },
    };
    const updateProfile = createUpdateProfile({
      profiles,
      consentStatus: {
        async getStatus() {
          return { needsAcceptance: [] };
        },
      },
      supportedLocales: ['pt-BR', 'en', 'es'],
      defaultLocale: 'pt-BR',
    });

    await expect(
      updateProfile({
        userId: USER_ID,
        email: null,
        profileLocaleHint: undefined,
        patch: { displayName: ' \u0000 ' },
      }),
    ).rejects.toThrow('Invalid user profile displayName.');
    expect(writes).toBe(0);
  });
});
