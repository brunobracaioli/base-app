export type AuthorizationRequest = {
  readonly auth: UserAuthContext;
  readonly host: string;
  readonly method: string;
  readonly path: string;
  readonly now: Date;
  loadFreshRoles(): Promise<readonly string[]>;
};

export type AuthorizationDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly status: 401 | 403 | 404; readonly code: string };

export type AuthorizationPolicy = (request: AuthorizationRequest) => Promise<AuthorizationDecision>;

export type UserAuthContext = {
  readonly kind: 'user';
  readonly userId: string;
  readonly isAnonymous: boolean;
  readonly appRoles: readonly string[];
  readonly providers: readonly string[];
  readonly amr: readonly { readonly timestamp: number }[];
};

export type WebhookAuthContext = {
  readonly kind: 'webhook';
  readonly provider: string;
};

export type AuthContext = UserAuthContext | WebhookAuthContext;
