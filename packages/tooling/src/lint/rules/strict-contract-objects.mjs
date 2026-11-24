// @ts-check

import {
  hasChainedMethod,
  isTopLevelVariableInitializer,
  zodBindings,
  zodObjectFactory,
} from './ast-utils.mjs';

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'require strict contract objects and stripped webhook payloads' },
    schema: [],
    messages: {
      strict: 'Contract object schemas must use .strict() or z.strictObject().',
      stripOutsideWebhook: '.strip() is reserved for authenticated webhook payload schemas.',
      webhookPayload: 'Top-level webhook payload schemas must use .strip().',
    },
  },
  create(context) {
    const filename = context.filename.replaceAll('\\', '/');
    const isWebhookFile = /(?:^|\/)packages\/contracts\/src\/(?:.*\/)?webhooks\//.test(filename);
    const bindings = zodBindings(context.sourceCode.ast);

    return {
      CallExpression(node) {
        const factory = zodObjectFactory(node.callee, bindings);
        if (!factory) {
          return;
        }

        const isStrictObject = factory === 'strictObject' || hasChainedMethod(node, 'strict');
        const isStripped = hasChainedMethod(node, 'strip');
        const isTopLevel = isTopLevelVariableInitializer(node);

        if (!isWebhookFile && isStripped) {
          context.report({ node, messageId: 'stripOutsideWebhook' });
          return;
        }

        if (isWebhookFile && isTopLevel && !isStripped) {
          context.report({ node, messageId: 'webhookPayload' });
          return;
        }

        if (!isWebhookFile && !isStrictObject) {
          context.report({ node, messageId: 'strict' });
        }
      },
    };
  },
};

export default rule;
