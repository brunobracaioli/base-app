import type * as z from 'zod';

import type { AuthVerificationResult } from '../auth/types';
import type { AuthorizationPolicy, AuthContext, UserAuthContext } from '../authorization/types';
import type { AppLogger } from '../observability/logger';
import type { RateLimiter } from './rate-limit';
import type { WebhookVerifier } from './webhook-verifiers';

export type RouteAuthConfig =
  | { readonly kind: 'public' }
  | { readonly kind: 'user'; readonly requireRecentAuth?: boolean }
  | { readonly kind: 'webhook'; readonly provider: string; readonly verifier: WebhookVerifier };

export type RateLimitConfig = {
  readonly key: 'ip' | 'user' | 'global';
  readonly limit: number;
  readonly windowSec: number;
  readonly ipLimit?: number;
  readonly onStoreFailure: 'closed' | 'open';
};

export type RouteInputSchemas = {
  readonly body?: z.ZodType;
  readonly query?: z.ZodType;
  readonly headers?: z.ZodType;
};

type ParsedSchema<Schema> =
  NonNullable<Schema> extends z.ZodType ? z.output<NonNullable<Schema>> : undefined;

export type ParsedRouteInput<Schemas extends RouteInputSchemas> = {
  readonly body: ParsedSchema<Schemas['body']>;
  readonly query: ParsedSchema<Schemas['query']>;
  readonly headers: ParsedSchema<Schemas['headers']>;
};

export type StoredIdempotencyResponse = {
  readonly status: number;
  readonly body: unknown;
};

export type IdempotencyAcquireResult =
  | { readonly kind: 'acquired'; readonly leaseUntil: Date }
  | { readonly kind: 'completed'; readonly response: StoredIdempotencyResponse }
  | { readonly kind: 'in_progress' }
  | { readonly kind: 'key_reused' };

export interface IdempotencyStore {
  acquire(input: {
    readonly userId: string;
    readonly key: string;
    readonly requestHash: string;
    readonly now: Date;
    readonly leaseUntil: Date;
    readonly expiresAt: Date;
  }): Promise<IdempotencyAcquireResult>;
  complete(input: {
    readonly userId: string;
    readonly key: string;
    readonly requestHash: string;
    readonly leaseUntil: Date;
    readonly response: StoredIdempotencyResponse;
  }): Promise<void>;
  release(input: {
    readonly userId: string;
    readonly key: string;
    readonly requestHash: string;
    readonly leaseUntil: Date;
  }): Promise<void>;
}

export type GateDecision =
  | { readonly allow: true }
  | {
      readonly allow: false;
      readonly status: 426 | 503;
      readonly code: string;
      readonly title: string;
      readonly retryAfterSec?: 60;
    };

export type SecurityAuditEvent = {
  readonly action: 'security.authorization_policy_error';
  readonly actorType: 'system';
  readonly actorRef: null;
  readonly subjectRef: string | null;
  readonly resourceType: 'api_route';
  readonly resourceRef: string;
  readonly outcome: 'failed';
  readonly correlationId: string;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
};

export type RouteDependencies = {
  readonly now: () => Date;
  readonly requestId: () => string;
  /** Loaded from the validated server product configuration, never request input. */
  readonly recentAuthMaxAgeSec: number;
  readonly logger: AppLogger;
  readonly rateLimiter: RateLimiter;
  readonly idempotencyStore: IdempotencyStore;
  readonly authenticateUser: (token: string, request: Request) => Promise<AuthVerificationResult>;
  readonly checkVersionAndMaintenance: (input: {
    readonly request: Request;
    readonly operationId: string;
    readonly maintenance: 'block' | 'exempt';
  }) => Promise<GateDecision>;
  readonly authorizationPolicies: ReadonlyMap<
    string,
    { readonly policy: AuthorizationPolicy; readonly operator: boolean }
  >;
  readonly loadFreshRoles: (auth: UserAuthContext) => Promise<readonly string[]>;
  readonly recordSecurityEvent: (event: SecurityAuditEvent) => Promise<void>;
};

export type RouteHandlerContext<Schemas extends RouteInputSchemas> = {
  readonly request: Request;
  readonly auth: AuthContext | null;
  readonly input: ParsedRouteInput<Schemas>;
  readonly requestId: string;
  readonly correlationId: string;
  readonly clientRequestId: string | null;
  readonly now: Date;
  readonly host: string;
};

type DefineRouteCommon<Schemas extends RouteInputSchemas> = {
  readonly operationId: string;
  readonly auth: RouteAuthConfig;
  readonly rateLimit: RateLimitConfig;
  readonly input?: Schemas;
  readonly maxBodyBytes?: number;
  readonly maintenance?: 'block' | 'exempt';
  readonly cachePolicy?: 'public-app-config';
  readonly authorize?: readonly string[];
  readonly destructive?: boolean;
  readonly idempotency?: 'none' | 'required';
};

export type DefineRouteInput<Schemas extends RouteInputSchemas, Output> =
  | (DefineRouteCommon<Schemas> & {
      readonly successStatus?: 200;
      readonly output: z.ZodType<Output>;
      readonly handler: (context: RouteHandlerContext<Schemas>) => Promise<Output> | Output;
    })
  | (DefineRouteCommon<Schemas> & {
      readonly successStatus: 204;
      readonly output: z.ZodType<undefined>;
      readonly handler: (context: RouteHandlerContext<Schemas>) => Promise<undefined> | undefined;
    });

export type ApiRequestContext = {
  readonly request: Request;
  readonly auth: AuthContext | null;
  readonly requestId: string;
  readonly correlationId: string;
  readonly clientRequestId: string | null;
  readonly now: Date;
  readonly host: string;
};
