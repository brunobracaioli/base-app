import { describe, expect, it } from 'vitest';

import { InvalidLegalVersionsError, parseLegalVersions } from '../domain/legal-versions';

describe('legal versions domain', () => {
  it('accepts exactly the two valid current document versions', () => {
    expect(
      parseLegalVersions({ termsVersion: '2024-02-29', privacyVersion: '2026-11-25' }),
    ).toEqual({ termsVersion: '2024-02-29', privacyVersion: '2026-11-25' });
  });

  it.each([
    null,
    [],
    { termsVersion: '2025-02-29', privacyVersion: '2026-11-25' },
    { termsVersion: '2026-11-24', privacyVersion: '2026-11-25', extra: true },
    { termsVersion: '2026-11-24' },
  ])('rejects malformed legal settings: %j', (input) => {
    expect(() => parseLegalVersions(input)).toThrow(InvalidLegalVersionsError);
  });
});
