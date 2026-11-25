import type { Clock, ConsentRepository, LegalVersionsReader } from './domain/consent-ports';
import { createAcceptConsent } from './features/accept-consent/application/command';
import { createGetConsentStatus } from './features/consent-status/application/query';

export function createPrivacyUseCases(input: {
  readonly consents: ConsentRepository;
  readonly legalVersions: LegalVersionsReader;
  readonly clock: Clock;
}) {
  return Object.freeze({
    getConsentStatus: createGetConsentStatus(input),
    acceptConsent: createAcceptConsent(input),
  });
}

export { createConsentRepository } from './infrastructure/consent-repository';
export { createPrivacyPurgeHandler } from './infrastructure/purge-handler';
export { ConsentVersionOutdatedError } from './features/accept-consent/application/command';
export {
  ConsentRecord,
  InvalidConsentRecordError,
  currentLegalVersion,
  isLegalVersion,
} from './domain/consent-record';
export type {
  ConsentRepository,
  ConsentStatus,
  Clock,
  LegalVersionsReader,
} from './domain/consent-ports';
export type {
  ConsentDocument,
  LegalVersions,
  ConsentRecordSnapshot,
} from './domain/consent-record';
export type { AcceptConsentInput } from './features/accept-consent/application/command';
