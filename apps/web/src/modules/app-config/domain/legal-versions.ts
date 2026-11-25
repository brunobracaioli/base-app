export type LegalVersions = {
  readonly termsVersion: string;
  readonly privacyVersion: string;
};

export class InvalidLegalVersionsError extends Error {
  constructor() {
    super('Current legal versions are invalid.');
    this.name = 'InvalidLegalVersionsError';
  }
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function parseLegalVersions(value: unknown): LegalVersions {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidLegalVersionsError();
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 2 ||
    !keys.includes('termsVersion') ||
    !keys.includes('privacyVersion') ||
    !isIsoDate(record.termsVersion) ||
    !isIsoDate(record.privacyVersion)
  ) {
    throw new InvalidLegalVersionsError();
  }
  return { termsVersion: record.termsVersion, privacyVersion: record.privacyVersion };
}
