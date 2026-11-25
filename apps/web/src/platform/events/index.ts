import type { DomainEvent, PurgeReason } from '../extensions/types';

export const ACCOUNT_PURGE_REQUESTED = 'account.purge_requested' as const;

/** Published only after privacy has validated a PurgeAuthorization. */
export type AccountPurgeRequested = DomainEvent & {
  readonly type: typeof ACCOUNT_PURGE_REQUESTED;
  readonly userId: string;
  readonly reason: PurgeReason;
  readonly caller: string;
};

export type { DomainEvent };
