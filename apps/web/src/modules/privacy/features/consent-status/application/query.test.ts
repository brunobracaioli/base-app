import { describe, expect, it } from 'vitest';

import { createGetConsentStatus } from './query';
import { ConsentRecord } from '../../../domain/consent-record';
import type { ConsentRepository, LegalVersionsReader } from '../../../domain/consent-ports';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ACCEPTED_AT = new Date('2026-11-25T12:00:00.000Z');

describe('getConsentStatus use case', () => {
  it('compares each current legal version with only this user’s accepted records', async () => {
    const readUsers: string[] = [];
    const consents: ConsentRepository = {
      async listForUser(userId) {
        readUsers.push(userId);
        return [
          ConsentRecord.restore({
            userId,
            document: 'terms',
            version: '2026-11-24',
            acceptedAt: ACCEPTED_AT,
          }),
          ConsentRecord.restore({
            userId,
            document: 'privacy',
            version: '2026-11-01',
            acceptedAt: ACCEPTED_AT,
          }),
        ];
      },
      async accept() {
        throw new Error('status query must not write.');
      },
    };
    const legalVersions: LegalVersionsReader = {
      async readCurrent() {
        return { termsVersion: '2026-11-24', privacyVersion: '2026-11-25' };
      },
    };

    const status = await createGetConsentStatus({ consents, legalVersions })(USER_ID);

    expect(status.needsAcceptance).toEqual(['privacy']);
    expect(readUsers).toEqual([USER_ID]);
  });

  it('requests both documents when there are no accepted records', async () => {
    const consents: ConsentRepository = {
      async listForUser() {
        return [];
      },
      async accept() {},
    };
    const legalVersions: LegalVersionsReader = {
      async readCurrent() {
        return { termsVersion: '2026-11-24', privacyVersion: '2026-11-25' };
      },
    };

    await expect(createGetConsentStatus({ consents, legalVersions })(USER_ID)).resolves.toEqual({
      needsAcceptance: ['terms', 'privacy'],
    });
  });
});
