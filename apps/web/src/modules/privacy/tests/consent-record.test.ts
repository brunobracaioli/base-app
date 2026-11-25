import { describe, expect, it } from 'vitest';

import {
  ConsentRecord,
  InvalidConsentRecordError,
  currentLegalVersion,
  isLegalVersion,
} from '../domain/consent-record';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ACCEPTED_AT = new Date('2026-11-25T12:00:00.000Z');
const VERSIONS = { termsVersion: '2026-11-24', privacyVersion: '2026-11-25' } as const;

describe('consent record domain', () => {
  it('accepts only calendar-valid ISO document versions', () => {
    expect(isLegalVersion('2024-02-29')).toBe(true);
    expect(isLegalVersion('2025-02-29')).toBe(false);
    expect(isLegalVersion('2026-1-01')).toBe(false);
  });

  it('resolves the authoritative version for each legal document', () => {
    expect(currentLegalVersion('terms', VERSIONS)).toBe('2026-11-24');
    expect(currentLegalVersion('privacy', VERSIONS)).toBe('2026-11-25');
    expect(() => currentLegalVersion('terms', { ...VERSIONS, termsVersion: 'bad' })).toThrow(
      InvalidConsentRecordError,
    );
  });

  it('models a record as current only when the stored version matches the current version', () => {
    const record = ConsentRecord.restore({
      userId: USER_ID,
      document: 'terms',
      version: VERSIONS.termsVersion,
      acceptedAt: ACCEPTED_AT,
    });

    expect(record.isCurrent(VERSIONS)).toBe(true);
    expect(record.isCurrent({ ...VERSIONS, termsVersion: '2026-11-26' })).toBe(false);
    expect(record.acceptedAt).toEqual(ACCEPTED_AT);
    expect(record.acceptedAt).not.toBe(ACCEPTED_AT);
  });

  it('rejects malformed records', () => {
    expect(() =>
      ConsentRecord.restore({
        userId: 'not-a-uuid',
        document: 'terms',
        version: VERSIONS.termsVersion,
        acceptedAt: ACCEPTED_AT,
      }),
    ).toThrow(InvalidConsentRecordError);
    expect(() =>
      ConsentRecord.restore({
        userId: USER_ID,
        document: 'terms',
        version: 'not-a-date',
        acceptedAt: ACCEPTED_AT,
      }),
    ).toThrow(InvalidConsentRecordError);
    expect(() =>
      ConsentRecord.restore({
        userId: USER_ID,
        document: 'privacy',
        version: VERSIONS.privacyVersion,
        acceptedAt: new Date(Number.NaN),
      }),
    ).toThrow(InvalidConsentRecordError);
  });
});
