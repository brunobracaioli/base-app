import type { AuthorizationPolicy } from '../authorization/types';

export type Entitlement = {
  readonly key: string;
  readonly expiresAt: Date | null;
  readonly willRenew: boolean | null;
  readonly store: 'app_store' | 'play_store' | 'stripe' | 'promotional' | 'test_store' | 'unknown';
  readonly isSandbox: boolean | null;
};

export type EntitlementsSnapshot = {
  readonly entitlements: readonly Entitlement[];
  readonly fetchedAt: Date;
};

export interface EntitlementsReader {
  read(userId: string, options: { readonly fresh: boolean }): Promise<EntitlementsSnapshot>;
}

export type DeletionOutcome =
  { readonly status: 'completed' } | { readonly status: 'scheduled'; readonly scheduledFor: Date };

export interface AccountDeletionPolicy {
  request(input: {
    readonly userId: string;
    readonly channel: 'app' | 'web';
    readonly correlationId: string;
  }): Promise<DeletionOutcome>;
  cancel(input: {
    readonly userId: string;
    readonly correlationId: string;
  }): Promise<{ readonly status: 'cancelled' } | { readonly status: 'none' }>;
  getPending(input: { readonly userId: string }): Promise<{ readonly scheduledFor: Date } | null>;
}

export type EmailMessage = {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly idempotencyKey: string;
};

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export type AuthorizationPolicies = ReadonlyMap<
  string,
  { readonly policy: AuthorizationPolicy; readonly operator: boolean }
>;

export type OverridablePorts = {
  readonly EntitlementsReader: EntitlementsReader;
  readonly AccountDeletionPolicy: AccountDeletionPolicy;
  readonly EmailSender: EmailSender;
  readonly AuthorizationPolicies: AuthorizationPolicies;
};
