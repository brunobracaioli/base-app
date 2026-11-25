import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import baseApp from './packages/tooling/src/lint/index.mjs';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/.turbo/**', '**/dist/**', '**/coverage/**', 'docs/**'],
  },
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    languageOptions: {
      globals: globals.node,
    },
    plugins: {
      'base-app': baseApp,
    },
    rules: {
      'no-console': 'error',
      'base-app/no-purge-account-outside-privacy': 'error',
      'base-app/no-direct-jwt-verify': 'error',
      'base-app/no-dynamic-log-message': 'error',
      'base-app/webhook-schemas-only-in-webhook-routes': 'error',
    },
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      'no-undef': 'off',
    },
  },
  {
    files: ['packages/contracts/src/**/*.{ts,tsx}'],
    rules: {
      'base-app/strict-contract-objects': 'error',
    },
  },
  {
    files: ['apps/web/src/**/*.{js,mjs,cjs,ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
    },
  },
  prettier,
);
