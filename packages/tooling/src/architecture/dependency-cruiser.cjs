const forbidden = [
  {
    name: 'no-unresolved',
    severity: 'error',
    from: {},
    to: { couldNotResolve: true },
  },
  {
    name: 'no-cross-module-internals',
    severity: 'error',
    from: { path: '^apps/web/src/modules/([^/]+)/' },
    to: {
      path: '^apps/web/src/modules/[^/]+/(?!index\\.tsx?$)',
      pathNot: '^apps/web/src/modules/$1/',
    },
  },
  {
    name: 'extensions-use-module-apis',
    severity: 'error',
    from: { path: '^apps/web/src/extensions/' },
    to: { path: '^apps/web/src/modules/[^/]+/(?!index\\.tsx?$)' },
  },
  {
    name: 'no-module-cycles',
    severity: 'error',
    from: { path: '^apps/web/src/modules/' },
    to: { circular: true },
  },
  {
    name: 'domain-is-pure-app-source',
    severity: 'error',
    from: { path: '^apps/web/src/modules/([^/]+)/domain/' },
    to: { path: '^apps/(?!web/src/modules/$1/domain/|web/src/platform/kernel(?:/|$))' },
  },
  {
    name: 'domain-is-pure-workspace-package',
    severity: 'error',
    from: { path: '^apps/web/src/modules/[^/]+/domain/' },
    to: { path: '^packages/' },
  },
  {
    name: 'domain-is-pure-external-dependency',
    severity: 'error',
    from: { path: '^apps/web/src/modules/[^/]+/domain/' },
    to: {
      dependencyTypes: [
        'npm',
        'npm-dev',
        'npm-no-pkg',
        'npm-optional',
        'npm-peer',
        'npm-unknown',
        'core',
      ],
    },
  },
  {
    name: 'application-no-infra',
    severity: 'error',
    from: { path: '^apps/web/src/modules/[^/]+/features/[^/]+/application/' },
    to: { path: '^apps/web/src/modules/[^/]+/infrastructure/' },
  },
  {
    name: 'routes-are-thin',
    severity: 'error',
    from: { path: '^apps/web/src/app/api/.*/route\\.[jt]sx?$' },
    to: { path: '^apps/web/src/(?!modules/[^/]+/index\\.tsx?$|extensions/|platform/http/)' },
  },
  {
    name: 'routes-are-thin-packages',
    severity: 'error',
    from: { path: '^apps/web/src/app/api/.*/route\\.[jt]sx?$' },
    to: { path: '^packages/' },
  },
  {
    name: 'routes-are-thin-dependencies',
    severity: 'error',
    from: { path: '^apps/web/src/app/api/.*/route\\.[jt]sx?$' },
    to: {
      dependencyTypes: [
        'npm',
        'npm-dev',
        'npm-no-pkg',
        'npm-optional',
        'npm-peer',
        'npm-unknown',
        'core',
      ],
    },
  },
  {
    name: 'mobile-no-server',
    severity: 'error',
    from: { path: '^apps/mobile/' },
    to: { path: '^apps/web/' },
  },
  {
    name: 'mobile-extensions-use-public-facade',
    severity: 'error',
    from: {
      path: '^apps/mobile/src/(?:extensions/(?!api\\.ts$|registry\\.ts$|types\\.ts$|[^/]+\\.test\\.[jt]sx?$)|app/\\(ext\\)/(?!.*\\.test\\.[jt]sx?$))',
    },
    to: { path: '^apps/mobile/src/(?:composition/|features/auth/|shared/api-client/)' },
  },
  {
    name: 'mobile-private-core-imports-only-from-core',
    severity: 'error',
    from: {
      path: '^apps/mobile/src/(?!extensions/(?:api|registry|types)\\.ts$|extensions/api\\.test\\.tsx$|features/shell/ui/(?:app-providers|settings-screen)\\.tsx$|features/auth/|composition/|shared/api-client/(?:index\\.ts|api-client\\.test\\.ts)$|app/\\(auth\\)/(?:_layout|welcome|email|code|password|sign-up|forgot-password|new-password)\\.tsx$|app/\\(app\\)/(?:reauth\\.tsx|settings/(?:account|change-email|change-password)\\.tsx)|app/\\(gates\\)/terms\\.tsx$)',
    },
    to: { path: '^apps/mobile/src/(?:composition/|features/auth/)' },
  },
  {
    name: 'mobile-private-api-client-imports-only-from-core',
    severity: 'error',
    from: {
      path: '^apps/mobile/src/(?!extensions/(?:api|registry|types)\\.ts$|extensions/api\\.test\\.tsx$|features/shell/ui/app-providers(?:\\.test)?\\.tsx$|features/auth/|composition/|shared/api-client/(?:index\\.ts|api-client\\.test\\.ts)$|features/app-config/(?:ui/app-config-provider(?:\\.test)?\\.tsx|api/app-config-reader(?:\\.test)?\\.ts)$)',
    },
    to: { path: '^apps/mobile/src/shared/api-client/' },
  },
  {
    name: 'supabase-client-only-in-auth',
    severity: 'error',
    from: { path: '^apps/mobile/src/(?!features/auth/)' },
    to: { path: '(^|/)@supabase/supabase-js(?:/|$)' },
  },
  {
    name: 'supabase-auth-adapters-only-in-auth',
    severity: 'error',
    from: { path: '^apps/mobile/src/(?!features/auth/)' },
    to: { path: '^apps/mobile/src/features/auth/adapters/' },
  },
  {
    name: 'system-db-only-from-context-infrastructure',
    severity: 'error',
    from: { path: '^apps/web/src/(?!modules/[^/]+/infrastructure/)' },
    to: { path: '^apps/web/src/platform/db/system/[^/]+\\.ts$' },
  },
  {
    name: 'system-db-per-context',
    severity: 'error',
    from: { path: '^apps/web/src/modules/([^/]+)/infrastructure/' },
    to: {
      path: '^apps/web/src/platform/db/system/(?!$1\\.ts$)[^/]+\\.ts$',
    },
  },
];

module.exports = {
  forbidden,
  options: {
    doNotFollow: { path: 'node_modules' },
    parser: 'tsc',
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      conditionNames: ['node', 'import', 'types', 'default'],
      exportsFields: ['exports'],
      extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'],
    },
  },
};
