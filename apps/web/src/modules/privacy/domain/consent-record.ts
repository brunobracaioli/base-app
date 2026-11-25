export type ConsentDocument = 'terms' | 'privacy';

export type LegalVersions = {
  readonly termsVersion: string;
  readonly privacyVersion: string;
};

export type ConsentRecordSnapshot = {
  readonly userId: string;
  readonly document: ConsentDocument;
  readonly version: string;
  readonly acceptedAt: Date;
};

export class InvalidConsentRecordError extends Error {
  constructor(readonly field: 'userId' | 'document' | 'version' | 'acceptedAt') {
    super(`Invalid consent record ${field}.`);
    this.name = 'InvalidConsentRecordError';
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isLegalVersion(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function currentLegalVersion(document: ConsentDocument, versions: LegalVersions): string {
  const version = document === 'terms' ? versions.termsVersion : versions.privacyVersion;
  if (!isLegalVersion(version)) throw new InvalidConsentRecordError('version');
  return version;
}

export class ConsentRecord {
  private constructor(
    readonly userId: string,
    readonly document: ConsentDocument,
    readonly version: string,
    readonly acceptedAt: Date,
  ) {}

  static restore(input: ConsentRecordSnapshot): ConsentRecord {
    if (!UUID_PATTERN.test(input.userId)) throw new InvalidConsentRecordError('userId');
    if (input.document !== 'terms' && input.document !== 'privacy') {
      throw new InvalidConsentRecordError('document');
    }
    if (!isLegalVersion(input.version)) throw new InvalidConsentRecordError('version');
    if (!(input.acceptedAt instanceof Date) || !Number.isFinite(input.acceptedAt.getTime())) {
      throw new InvalidConsentRecordError('acceptedAt');
    }
    return new ConsentRecord(
      input.userId,
      input.document,
      input.version,
      new Date(input.acceptedAt.getTime()),
    );
  }

  isCurrent(versions: LegalVersions): boolean {
    return this.version === currentLegalVersion(this.document, versions);
  }
}
