import type {
  ConsentRepository,
  ConsentStatus,
  LegalVersionsReader,
} from '../../../domain/consent-ports';

const DOCUMENTS = ['terms', 'privacy'] as const;

export function createGetConsentStatus(input: {
  readonly consents: ConsentRepository;
  readonly legalVersions: LegalVersionsReader;
}): (userId: string) => Promise<ConsentStatus> {
  return async (userId) => {
    const versions = await input.legalVersions.readCurrent();
    const records = await input.consents.listForUser(userId);
    const needsAcceptance = DOCUMENTS.filter(
      (document) =>
        !records.some((record) => record.document === document && record.isCurrent(versions)),
    );
    return { needsAcceptance };
  };
}
