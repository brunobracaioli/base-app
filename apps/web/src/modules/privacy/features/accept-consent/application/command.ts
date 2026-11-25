import type { Clock, ConsentRepository, LegalVersionsReader } from '../../../domain/consent-ports';
import {
  ConsentRecord,
  currentLegalVersion,
  type ConsentDocument,
} from '../../../domain/consent-record';

export class ConsentVersionOutdatedError extends Error {
  constructor(readonly document: ConsentDocument) {
    super('The requested legal document version is no longer current.');
    this.name = 'ConsentVersionOutdatedError';
  }
}

export type AcceptConsentInput = {
  readonly userId: string;
  readonly document: ConsentDocument;
  readonly version: string;
};

export function createAcceptConsent(input: {
  readonly consents: ConsentRepository;
  readonly legalVersions: LegalVersionsReader;
  readonly clock: Clock;
}): (command: AcceptConsentInput) => Promise<void> {
  return async (command) => {
    const versions = await input.legalVersions.readCurrent();
    if (command.version !== currentLegalVersion(command.document, versions)) {
      throw new ConsentVersionOutdatedError(command.document);
    }

    const record = ConsentRecord.restore({
      userId: command.userId,
      document: command.document,
      version: command.version,
      acceptedAt: input.clock.now(),
    });
    await input.consents.accept(record);
  };
}
