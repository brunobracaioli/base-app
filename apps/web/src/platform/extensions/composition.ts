import * as z from 'zod';

import type { AuthorizationPolicy } from '../authorization/types';
import type {
  DomainEvent,
  EventHandler,
  ExtensionComposition,
  ExtensionRegistry,
  ExtensionRuntimeOptions,
  ExtensionSystemRole,
  ExportSectionProvider,
  PurgeJobHandle,
  ServerExtension,
  SiteExtension,
  SiteExtensionComposition,
  SystemPurgeReason,
} from './types';
import type { OverridablePorts } from './ports';

type RegisteredEventHandler = {
  readonly handler: EventHandler<DomainEvent>;
  readonly timeoutMs: number;
};

const DEFAULT_CORE_SYSTEM_ROLES = [
  'identity_system',
  'privacy_system',
  'app_config_system',
  'platform_system',
  'ops',
  'auth_fn_owner',
] as const;

const ENV_SECRET_NAME_PATTERN = /SECRET|KEY_PRIVATE|TOKEN/i;
const SITE_PUBLIC_PREFIX = 'NEXT_PUBLIC_';
const CORE_EXPORT_SECTION_NAMES = new Set([
  'exportedAt',
  'account',
  'profile',
  'consents',
  'entitlements',
  'auditEvents',
]);

function validExtensionName(name: string): boolean {
  return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name);
}

function validateExtensionNames(extensions: readonly { readonly name: string }[]): void {
  const names = new Set<string>();
  for (const extension of extensions) {
    if (!validExtensionName(extension.name)) {
      throw new Error(`Invalid extension name: ${extension.name}`);
    }
    if (names.has(extension.name)) throw new Error(`Duplicate extension name: ${extension.name}`);
    names.add(extension.name);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error('Extension event handler timed out.')),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  });
}

function buildExtensionEnvKeys(
  extensions: readonly ServerExtension[],
  coreKeys: readonly string[],
): ReadonlyMap<string, string> {
  const owners = new Map<string, string>(coreKeys.map((key) => [key, 'core']));
  const byExtension = new Map<string, string>();
  for (const extension of extensions) {
    for (const key of Object.keys(extension.env?.shape ?? {})) {
      const existing = owners.get(key);
      if (existing) throw new Error(`Environment key collision: ${key}`);
      owners.set(key, extension.name);
      byExtension.set(`${extension.name}:${key}`, key);
    }
  }
  return byExtension;
}

function buildSystemRoles(
  extensions: readonly ServerExtension[],
  coreRoles: readonly string[],
): ExtensionSystemRole[] {
  const core = new Set(coreRoles);
  const roles = new Set<string>();
  const validated: ExtensionSystemRole[] = [];
  for (const extension of extensions) {
    const expected = `${extension.name.replaceAll('-', '_')}_system`;
    for (const role of extension.systemRoles ?? []) {
      if (role !== expected || core.has(role) || roles.has(role)) {
        throw new Error(`Invalid or duplicate extension system role for ${extension.name}.`);
      }
      roles.add(role);
      validated.push(role as ExtensionSystemRole);
    }
  }
  return validated;
}

export function composeServerExtensions(
  extensions: readonly ServerExtension[],
  options: ExtensionRuntimeOptions = {},
): ExtensionComposition {
  validateExtensionNames(extensions);
  buildExtensionEnvKeys(extensions, options.coreEnvironmentKeys ?? []);
  const extensionSystemRoles = buildSystemRoles(
    extensions,
    options.coreSystemRoles ?? DEFAULT_CORE_SYSTEM_ROLES,
  );
  const environment = options.environment ?? process.env;
  for (const extension of extensions) extension.env?.parse(environment);

  const overrides = new Map<keyof OverridablePorts, OverridablePorts[keyof OverridablePorts]>();
  const eventHandlers = new Map<string, RegisteredEventHandler[]>();
  const authorizationPolicies = new Map<
    string,
    { readonly policy: AuthorizationPolicy; readonly operator: boolean }
  >();
  const exportSections = new Map<string, ExportSectionProvider>();
  const purgeJobs = new Set<string>();

  const registry: ExtensionRegistry = {
    onEvent<Event extends DomainEvent>(
      type: Event['type'],
      handler: EventHandler<Event>,
      eventOptions: { readonly timeoutMs?: number } = {},
    ): void {
      const timeoutMs = eventOptions.timeoutMs ?? 3_000;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 8_000) {
        throw new Error('Extension event timeout must be between 1 and 8000 ms.');
      }
      const handlers = eventHandlers.get(type) ?? [];
      handlers.push({ handler: handler as EventHandler<DomainEvent>, timeoutMs });
      eventHandlers.set(type, handlers);
    },
    override<Key extends keyof OverridablePorts>(
      port: Key,
      implementation: OverridablePorts[Key],
    ): void {
      if (overrides.has(port)) throw new Error(`Port already overridden: ${port}`);
      overrides.set(port, implementation);
    },
    addAuthorizationPolicy(name, policy, policyOptions = {}): void {
      if (!/^[a-z][a-z0-9_.-]{1,48}$/.test(name)) {
        throw new Error(`Invalid authorization policy name: ${name}`);
      }
      if (authorizationPolicies.has(name))
        throw new Error(`Duplicate authorization policy: ${name}`);
      authorizationPolicies.set(name, { policy, operator: policyOptions.operator === true });
    },
    addExportSection(name, provider): void {
      if (CORE_EXPORT_SECTION_NAMES.has(name)) {
        throw new Error(`Export section name is reserved by the core: ${name}`);
      }
      if (!/^[a-z][a-z0-9_]{0,31}$/.test(name))
        throw new Error(`Invalid export section name: ${name}`);
      if (exportSections.has(name)) throw new Error(`Duplicate export section: ${name}`);
      exportSections.set(name, provider);
    },
    registerPurgeJob(job): PurgeJobHandle {
      if (!/^[a-z][a-z0-9_.-]{1,48}$/.test(job.name) || purgeJobs.has(job.name)) {
        throw new Error(`Invalid or duplicate purge job: ${job.name}`);
      }
      if (!Number.isSafeInteger(job.maxPerMinute) || job.maxPerMinute < 1) {
        throw new Error(`Invalid purge rate for job: ${job.name}`);
      }
      const reasons = new Set<SystemPurgeReason>(job.reasons);
      if (reasons.size !== job.reasons.length || reasons.size === 0) {
        throw new Error(`Invalid purge reasons for job: ${job.name}`);
      }
      purgeJobs.add(job.name);
      return {
        authorize(userId, reason) {
          if (!reasons.has(reason))
            throw new Error(`Purge reason is not registered for job: ${job.name}`);
          const issuer = options.purgeAuthorizationIssuer;
          if (!issuer) throw new Error('Purge authorization is unavailable.');
          return issuer({ userId, reason, issuedBy: `job:${job.name}` });
        },
      };
    },
  };

  for (const extension of extensions) {
    for (const [port, implementation] of Object.entries(extension.overrides ?? {}) as [
      keyof OverridablePorts,
      OverridablePorts[keyof OverridablePorts],
    ][]) {
      registry.override(port, implementation);
    }
    const roles = new Set(extension.systemRoles ?? []);
    const scopedRegistry: ExtensionRegistry = {
      ...registry,
      addExportSection(name, provider) {
        if (provider.systemRole && !roles.has(provider.systemRole)) {
          throw new Error(`Export section system role is not declared by ${extension.name}.`);
        }
        registry.addExportSection(name, provider);
      },
    };
    extension.register(scopedRegistry);
  }

  const frozenOverrides = Object.fromEntries(overrides) as Partial<OverridablePorts>;
  return {
    registry,
    overrides: frozenOverrides,
    authorizationPolicies,
    exportSections,
    extensionSystemRoles: Object.freeze(extensionSystemRoles),
    async dispatchEvent<Event extends DomainEvent>(event: Event): Promise<void> {
      const handlers = eventHandlers.get(event.type) ?? [];
      for (const entry of handlers) await withTimeout(entry.handler(event), entry.timeoutMs);
    },
  };
}

export function composeSiteExtensions(
  extensions: readonly SiteExtension[],
  environment: Readonly<Record<string, string | undefined>>,
  corePublicKeys: readonly string[] = [],
): SiteExtensionComposition {
  validateExtensionNames(extensions);
  const occupiedKeys = new Set(corePublicKeys);
  const publicEnvironment: Record<string, string | undefined> = {};
  let captchaWidget: SiteExtension['captchaWidget'];

  for (const extension of extensions) {
    if (extension.captchaWidget) {
      if (captchaWidget) throw new Error('Only one site extension may register a CAPTCHA widget.');
      captchaWidget = extension.captchaWidget;
    }
    if (!extension.publicEnv) continue;
    const keys = Object.keys(extension.publicEnv.shape);
    for (const key of keys) {
      if (!key.startsWith(SITE_PUBLIC_PREFIX) || ENV_SECRET_NAME_PATTERN.test(key)) {
        throw new Error(`Invalid public site environment key: ${key}`);
      }
      if (occupiedKeys.has(key)) throw new Error(`Public site environment key collision: ${key}`);
      occupiedKeys.add(key);
    }
    const input = Object.fromEntries(keys.map((key) => [key, environment[key]]));
    const parsed = extension.publicEnv.parse(input) as Record<string, string | undefined>;
    Object.assign(publicEnvironment, parsed);
  }

  return { captchaWidget, publicEnvironment: Object.freeze(publicEnvironment) };
}

export function assertCoreExtensionContracts(
  extensions: readonly ServerExtension[],
  options?: ExtensionRuntimeOptions,
): void {
  composeServerExtensions(extensions, options);
  composeSiteExtensions([], {});
}

export const emptyServerExtensions: readonly ServerExtension[] = [];
export const emptySiteExtensions: readonly SiteExtension[] = [];

export const extensionEnvironmentSchema = z.object({}).passthrough();
