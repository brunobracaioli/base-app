import { AppConfigResponse, type AppConfigResponseValue } from '@base-app/contracts';
import product from '@base-app/config/product.config';

const defaultLegalVersion = '2026-01-01';

function productUrl(path: string): string {
  return new URL(path, `${product.web.origin}/`).toString();
}

export function createDefaultAppConfig(): AppConfigResponseValue {
  const iosStoreUrl = `https://apps.apple.com/app/id${product.ios.appStoreId}`;
  const androidStoreUrl = new URL('https://play.google.com/store/apps/details');
  androidStoreUrl.searchParams.set('id', product.android.package);

  return AppConfigResponse.parse({
    versions: {
      ios: { minSupported: '0.0.0', latest: '0.0.0', storeUrl: iosStoreUrl },
      android: { minSupported: '0.0.0', latest: '0.0.0', storeUrl: androidStoreUrl.toString() },
    },
    maintenance: {
      active: false,
      platforms: ['ios', 'android'],
      messageKey: 'maintenance.default',
      until: null,
    },
    legal: {
      termsVersion: defaultLegalVersion,
      privacyVersion: defaultLegalVersion,
      termsUrl: productUrl(product.legal.termsPath),
      privacyUrl: productUrl(product.legal.privacyPath),
    },
  });
}
