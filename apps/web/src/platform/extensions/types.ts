import type * as z from 'zod';
import type { ComponentType } from 'react';

import type { AuthorizationPolicy } from '../authorization/types';
import type { ExtensionSystemRole } from '../kernel/extension-system-role';
import type { OverridablePorts } from './ports';

export type { ExtensionSystemRole } from '../kernel/extension-system-role';

export type DomainEvent = {
  readonly type: string;
  readonly occurredAt: string;
  readonly correlationId: string;
};

export type EventHandler<Event extends DomainEvent> = (event: Event) => Promise<void>;

export type PurgeReason = 'user_request' | 'scheduled' | 'guest_abandoned' | 'guest_merged';
export type SystemPurgeReason = Exclude<PurgeReason, 'user_request'>;

declare const purgeAuthorizationBrand: unique symbol;

export type PurgeAuthorization = {
  readonly [purgeAuthorizationBrand]: true;
  readonly userId: string;
  readonly reason: PurgeReason;
  readonly issuedBy: string;
};

export interface PurgeJobHandle {
  authorize(userId: string, reason: SystemPurgeReason): PurgeAuthorization;
}

export type CaptchaAction =
  | 'sign_up'
  | 'sign_in_password'
  | 'sign_in_otp'
  | 'reset_password'
  | 'anonymous'
  | 'resend'
  | 'reauth'
  | 'social';

export type CaptchaWidget = ComponentType<{
  readonly action: CaptchaAction;
  readonly onToken: (token: string) => void;
  readonly onExpire: () => void;
  readonly onError: () => void;
}>;

export type ExportDb = object;

export interface ExportSectionProvider {
  readonly systemRole?: string;
  readonly schema: z.ZodType;
  collect(context: { readonly userId: string; readonly db: ExportDb }): Promise<unknown>;
}

export type HardeningHeader =
  | 'Referrer-Policy'
  | 'Cross-Origin-Opener-Policy'
  | 'Cross-Origin-Resource-Policy'
  | 'X-Robots-Tag'
  | 'Cache-Control';

export type CspDirective = 'script-src' | 'frame-src' | 'connect-src' | 'style-src' | 'img-src';

export interface EdgeExtension {
  readonly name: string;
  readonly hosts?: readonly {
    readonly hostEnv: string;
    readonly pathPrefixes: readonly string[];
  }[];
  readonly csp?: readonly {
    readonly pathPrefix: string;
    readonly directives: Partial<Record<CspDirective, readonly string[]>>;
    readonly strict?: { readonly trustedTypesPolicies: readonly string[] };
  }[];
  readonly headers?: readonly {
    readonly pathPrefix: string;
    readonly set: Partial<Record<HardeningHeader, string>>;
  }[];
}

export interface SiteExtension {
  readonly name: string;
  readonly publicEnv?: z.ZodObject<z.ZodRawShape>;
  readonly captchaWidget?: CaptchaWidget;
}

export interface ExtensionRegistry {
  onEvent<Event extends DomainEvent>(
    type: Event['type'],
    handler: EventHandler<Event>,
    options?: { readonly timeoutMs?: number },
  ): void;
  override<Key extends keyof OverridablePorts>(
    port: Key,
    implementation: OverridablePorts[Key],
  ): void;
  addAuthorizationPolicy(
    name: string,
    policy: AuthorizationPolicy,
    options?: { readonly operator?: boolean },
  ): void;
  addExportSection(name: string, provider: ExportSectionProvider): void;
  registerPurgeJob(job: {
    readonly name: string;
    readonly reasons: readonly SystemPurgeReason[];
    readonly maxPerMinute: number;
  }): PurgeJobHandle;
}

export interface ServerExtension {
  readonly name: string;
  readonly env?: z.ZodObject<z.ZodRawShape>;
  readonly systemRoles?: readonly string[];
  readonly overrides?: Partial<OverridablePorts>;
  register(registry: ExtensionRegistry): void;
}

export type ExtensionComposition = {
  readonly registry: ExtensionRegistry;
  readonly overrides: Partial<OverridablePorts>;
  readonly authorizationPolicies: ReadonlyMap<
    string,
    { readonly policy: AuthorizationPolicy; readonly operator: boolean }
  >;
  readonly exportSections: ReadonlyMap<string, ExportSectionProvider>;
  readonly dispatchEvent: <Event extends DomainEvent>(event: Event) => Promise<void>;
  readonly extensionSystemRoles: readonly ExtensionSystemRole[];
};

export type ExtensionRuntimeOptions = {
  readonly purgeAuthorizationIssuer?: (input: {
    readonly userId: string;
    readonly reason: SystemPurgeReason;
    readonly issuedBy: string;
  }) => PurgeAuthorization;
  readonly coreEnvironmentKeys?: readonly string[];
  readonly coreSystemRoles?: readonly string[];
  readonly environment?: Readonly<Record<string, string | undefined>>;
};

export type SiteExtensionComposition = {
  readonly captchaWidget: CaptchaWidget | undefined;
  readonly publicEnvironment: Readonly<Record<string, string | undefined>>;
};
