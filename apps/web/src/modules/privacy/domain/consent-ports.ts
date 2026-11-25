import type { ConsentRecord, LegalVersions } from './consent-record';

export interface ConsentRepository {
  listForUser(userId: string): Promise<readonly ConsentRecord[]>;
  accept(record: ConsentRecord): Promise<void>;
}

export interface LegalVersionsReader {
  readCurrent(): Promise<LegalVersions>;
}

export interface Clock {
  now(): Date;
}

export type ConsentStatus = {
  readonly needsAcceptance: readonly ('terms' | 'privacy')[];
};
