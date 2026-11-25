import { describe, expect, it } from 'vitest';

import { createAcceptConsent, ConsentVersionOutdatedError } from './command';
import type { Clock, ConsentRepository, LegalVersionsReader } from '../../../domain/consent-ports';
import type { ConsentRecord } from '../../../domain/consent-record';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-11-25T12:00:00.000Z');

describe('acceptConsent use case', () => {
  it('accepts only the current version and uses the injected clock', async () => {
    const accepted: ConsentRecord[] = [];
    const consents: ConsentRepository = {
      async listForUser() {
        return [];
      },
      async accept(record) {
        accepted.push(record);
      },
    };
    const legalVersions: LegalVersionsReader = {
      async readCurrent() {
        return { termsVersion: '2026-11-24', privacyVersion: '2026-11-25' };
      },
    };
    const clock: Clock = { now: () => new Date(NOW.getTime()) };
    const accept = createAcceptConsent({ consents, legalVersions, clock });

    await accept({ userId: USER_ID, document: 'privacy', version: '2026-11-25' });

    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      userId: USER_ID,
      document: 'privacy',
      version: '2026-11-25',
      acceptedAt: NOW,
    });
  });

  it('rejects outdated versions before writing', async () => {
    let writes = 0;
    const consents: ConsentRepository = {
      async listForUser() {
        return [];
      },
      async accept() {
        writes += 1;
      },
    };
    const legalVersions: LegalVersionsReader = {
      async readCurrent() {
        return { termsVersion: '2026-11-24', privacyVersion: '2026-11-25' };
      },
    };
    const accept = createAcceptConsent({ consents, legalVersions, clock: { now: () => NOW } });

    await expect(
      accept({ userId: USER_ID, document: 'terms', version: '2026-11-23' }),
    ).rejects.toBeInstanceOf(ConsentVersionOutdatedError);
    expect(writes).toBe(0);
  });

  it('propagates reader or repository failures without accepting a stale version', async () => {
    const accept = createAcceptConsent({
      consents: {
        async listForUser() {
          return [];
        },
        async accept() {
          throw new Error('repository-failed');
        },
      },
      legalVersions: {
        async readCurrent() {
          return { termsVersion: '2026-11-24', privacyVersion: '2026-11-25' };
        },
      },
      clock: { now: () => NOW },
    });

    await expect(
      accept({ userId: USER_ID, document: 'terms', version: '2026-11-24' }),
    ).rejects.toThrow('repository-failed');
  });
});
