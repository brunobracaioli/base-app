import type { EdgeExtension } from '../extensions/types';
import { isPathWithinPrefix, normalizeHost, normalizePath, normalizePathPrefix } from './path';
import { validateEdgeCsp, validateEdgeHeaders } from './csp';

export type EdgeEnvironment = Readonly<Record<string, string | undefined>> & {
  readonly APP_HOST: string;
  readonly VERCEL_ENV?: string;
  readonly VERCEL_URL?: string;
  readonly VERCEL_BRANCH_URL?: string;
};

export type EdgeRouteDecision =
  | {
      readonly allowed: true;
      readonly hostKind: 'app' | 'extension';
      readonly extensionName?: string;
      readonly path: string;
    }
  | { readonly allowed: false };

type ExtensionHost = {
  readonly extensionName: string;
  readonly host: string;
  readonly prefixes: readonly string[];
};

function configuredHost(value: string, variable: string): string {
  const host = normalizeHost(value);
  if (!host) throw new TypeError(`Invalid host in ${variable}.`);
  return host;
}

function edgeExtensionHosts(
  extensions: readonly EdgeExtension[],
  environment: EdgeEnvironment,
): readonly ExtensionHost[] {
  const hosts: ExtensionHost[] = [];
  for (const extension of extensions) {
    for (const hostEntry of extension.hosts ?? []) {
      if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(hostEntry.hostEnv)) {
        throw new TypeError(`Invalid host environment name in extension ${extension.name}.`);
      }
      const rawHost = environment[hostEntry.hostEnv];
      if (!rawHost)
        throw new TypeError(`Host environment is missing for extension ${extension.name}.`);
      if (hostEntry.pathPrefixes.length === 0) {
        throw new TypeError(
          `Extension host ${extension.name} must declare at least one path prefix.`,
        );
      }
      const prefixes = hostEntry.pathPrefixes.map((prefix) => {
        const normalized = normalizePathPrefix(prefix);
        if (!normalized)
          throw new TypeError(`Invalid host path prefix in extension ${extension.name}.`);
        return normalized.value;
      });
      if (new Set(prefixes).size !== prefixes.length) {
        throw new TypeError(`Duplicate host path prefix in extension ${extension.name}.`);
      }
      hosts.push({
        extensionName: extension.name,
        host: configuredHost(rawHost, hostEntry.hostEnv),
        prefixes,
      });
    }
  }
  const uniqueHosts = new Set(hosts.map((entry) => entry.host));
  if (uniqueHosts.size !== hosts.length)
    throw new TypeError('Two extensions may not use the same host.');
  return hosts;
}

export function resolveEdgeRequest(input: {
  readonly requestHost: string | null;
  readonly requestPath: string;
  readonly environment: EdgeEnvironment;
  readonly extensions: readonly EdgeExtension[];
}): EdgeRouteDecision {
  if (!input.environment.APP_HOST) throw new TypeError('APP_HOST is required.');
  validateEdgeCsp(input.extensions);
  validateEdgeHeaders(input.extensions);

  const host = input.requestHost ? normalizeHost(input.requestHost) : null;
  const path = normalizePath(input.requestPath);
  if (!host || !path) return { allowed: false };

  const appHosts = new Set([configuredHost(input.environment.APP_HOST, 'APP_HOST')]);
  if (input.environment.VERCEL_ENV === 'preview') {
    for (const [name, value] of [
      ['VERCEL_URL', input.environment.VERCEL_URL],
      ['VERCEL_BRANCH_URL', input.environment.VERCEL_BRANCH_URL],
    ] as const) {
      if (value) appHosts.add(configuredHost(value, name));
    }
  }

  const extensionHosts = edgeExtensionHosts(input.extensions, input.environment);
  const allHosts = new Set(appHosts);
  for (const extension of extensionHosts) {
    if (allHosts.has(extension.host))
      throw new TypeError('Application and extension hosts must be unique.');
    allHosts.add(extension.host);
  }
  if (!allHosts.has(host)) return { allowed: false };

  const extensionHost = extensionHosts.find((entry) => entry.host === host);
  if (extensionHost) {
    if (!extensionHost.prefixes.some((prefix) => isPathWithinPrefix(path.value, prefix))) {
      return { allowed: false };
    }
    return {
      allowed: true,
      hostKind: 'extension',
      extensionName: extensionHost.extensionName,
      path: path.value,
    };
  }

  const extensionPathPrefixes = extensionHosts.flatMap((entry) => entry.prefixes);
  if (extensionPathPrefixes.some((prefix) => isPathWithinPrefix(path.value, prefix))) {
    return { allowed: false };
  }
  return { allowed: true, hostKind: 'app', path: path.value };
}
