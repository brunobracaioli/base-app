import { Linking } from 'react-native';

export type OpenExternalUrlOptions = {
  readonly allowedOrigins: readonly string[];
  readonly openUrl?: (url: string) => Promise<unknown>;
};

function matchesProductOrigin(url: URL, origins: readonly string[]): boolean {
  return origins.some((origin) => {
    try {
      const allowed = new URL(origin);
      return allowed.protocol === 'https:' && allowed.origin === url.origin;
    } catch {
      return false;
    }
  });
}

function matchesStoreOrRevenueCatHost(hostname: string): boolean {
  return (
    hostname === 'apps.apple.com' ||
    hostname === 'play.google.com' ||
    hostname === 'rev.cat' ||
    hostname.endsWith('.rev.cat') ||
    hostname.endsWith('.revenuecat.com')
  );
}

export function createOpenExternalUrl(
  options: OpenExternalUrlOptions,
): (value: string) => Promise<boolean> {
  const openUrl = options.openUrl ?? ((value: string) => Linking.openURL(value));
  return async (value: string): Promise<boolean> => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }

    if (
      url.protocol !== 'https:' ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      (!matchesProductOrigin(url, options.allowedOrigins) &&
        !matchesStoreOrRevenueCatHost(url.hostname))
    ) {
      return false;
    }

    try {
      await openUrl(url.toString());
      return true;
    } catch {
      return false;
    }
  };
}
