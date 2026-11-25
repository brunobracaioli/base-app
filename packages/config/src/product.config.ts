import { defineProduct } from './product.schema.js';

/**
 * Non-operational template example. Replace reserved `.invalid` origins and
 * sample IDs before connecting an app to Supabase or RevenueCat.
 */
const product = defineProduct({
  slug: 'myapp',
  displayName: 'My App',
  ios: { bundleId: 'com.example.myapp', appStoreId: '0000000000' },
  android: { package: 'com.example.myapp' },
  scheme: 'myapp',
  web: { origin: 'https://myapp.example.invalid' },
  locales: ['pt-BR', 'en', 'es'],
  defaultLocale: 'pt-BR',
  auth: {
    methods: ['email_otp', 'email_password'],
    recentAuthMaxAgeSec: 300,
  },
  billing: {
    entitlements: ['pro'],
    cacheTtlSec: 60,
  },
  environments: {
    production: {
      supabaseUrl: 'https://production.example.invalid',
      revenuecatProjectId: 'proj_prod',
    },
    staging: {
      supabaseUrl: 'https://staging.example.invalid',
      revenuecatProjectId: 'proj_stg',
    },
  },
  quotas: { 'examples.premium_action': { perDay: { pro: 500 }, globalPerDay: 20_000 } },
  legal: { termsPath: '/terms', privacyPath: '/privacy' },
  extensions: {},
});

export default product;
