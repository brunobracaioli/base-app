// @ts-check

import noDirectJwtVerify from './rules/no-direct-jwt-verify.mjs';
import noDynamicLogMessage from './rules/no-dynamic-log-message.mjs';
import noPurgeAccountOutsidePrivacy from './rules/no-purge-account-outside-privacy.mjs';
import strictContractObjects from './rules/strict-contract-objects.mjs';
import webhookSchemasOnlyInWebhookRoutes from './rules/webhook-schemas-only-in-webhook-routes.mjs';

/** @type {import('eslint').ESLint.Plugin} */
const plugin = {
  meta: {
    name: '@base-app/tooling',
    version: '0.0.0',
  },
  rules: {
    'strict-contract-objects': strictContractObjects,
    'no-purge-account-outside-privacy': noPurgeAccountOutsidePrivacy,
    'no-direct-jwt-verify': noDirectJwtVerify,
    'no-dynamic-log-message': noDynamicLogMessage,
    'webhook-schemas-only-in-webhook-routes': webhookSchemasOnlyInWebhookRoutes,
  },
};

export default plugin;
