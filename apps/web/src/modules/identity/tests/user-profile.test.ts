import { describe, expect, it } from 'vitest';

import {
  InvalidUserProfileError,
  UserProfile,
  normalizeDisplayName,
  normalizeProfilePatch,
  resolveInitialLocale,
} from '../domain/user-profile';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CREATED_AT = new Date('2026-11-25T12:00:00.000Z');
const LOCALES = ['pt-BR', 'en', 'es'] as const;

describe('user profile domain', () => {
  it('normalizes display names before enforcing the final length', () => {
    expect(normalizeDisplayName('  Cafe\u0301\u0000  ')).toBe('Café');
    expect(normalizeDisplayName('Name\nWith\tControls')).toBe('NameWithControls');
    expect(normalizeDisplayName(null)).toBeNull();
  });

  it('rejects a name that is empty or too long after normalization', () => {
    expect(() => normalizeDisplayName(' \u0000 ')).toThrow(InvalidUserProfileError);
    expect(() => normalizeDisplayName('x'.repeat(81))).toThrow(InvalidUserProfileError);
  });

  it('uses the verified hint only when it is in the product allowlist', () => {
    expect(resolveInitialLocale('es', LOCALES, 'pt-BR')).toBe('es');
    expect(resolveInitialLocale('fr', LOCALES, 'pt-BR')).toBe('pt-BR');
    expect(resolveInitialLocale(undefined, LOCALES, 'pt-BR')).toBe('pt-BR');
    expect(() => resolveInitialLocale(undefined, LOCALES, 'fr')).toThrow(InvalidUserProfileError);
  });

  it('applies only present fields and preserves the profile identity and creation time', () => {
    const profile = UserProfile.restore(
      { userId: USER_ID, displayName: 'Ana', locale: 'pt-BR', createdAt: CREATED_AT },
      LOCALES,
    );
    const result = profile.update({ displayName: '  A\u0301na\u0000  ' });

    expect(result.changes).toEqual({ displayName: 'Ána' });
    expect(result.profile).toMatchObject({ userId: USER_ID, displayName: 'Ána', locale: 'pt-BR' });
    expect(result.profile.createdAt).toEqual(CREATED_AT);
    expect(profile.displayName).toBe('Ana');
  });

  it('rejects updates with no present fields and locales outside the product allowlist', () => {
    expect(() => normalizeProfilePatch({}, LOCALES)).toThrow(InvalidUserProfileError);
    expect(() => normalizeProfilePatch({ locale: 'fr' }, LOCALES)).toThrow(InvalidUserProfileError);
  });

  it('rejects invalid persisted identity and creation time', () => {
    expect(() =>
      UserProfile.restore(
        { userId: 'not-a-uuid', displayName: null, locale: 'en', createdAt: CREATED_AT },
        LOCALES,
      ),
    ).toThrow(InvalidUserProfileError);
    expect(() =>
      UserProfile.restore(
        { userId: USER_ID, displayName: null, locale: 'en', createdAt: new Date(Number.NaN) },
        LOCALES,
      ),
    ).toThrow(InvalidUserProfileError);
  });
});
