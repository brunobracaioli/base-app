// @ts-check

import { identifierName, staticPropertyName } from './ast-utils.mjs';

const logMethods = new Set(['debug', 'error', 'fatal', 'info', 'trace', 'warn']);

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'require literal messages for structured log calls' },
    schema: [],
    messages: {
      dynamic: 'Use a literal log message and pass dynamic data in structured fields.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (
          node.callee.type !== 'MemberExpression' ||
          !logMethods.has(staticPropertyName(node.callee) ?? '')
        ) {
          return;
        }
        const object = node.callee.object;
        const objectName = identifierName(object);
        const isLoggerCall =
          (objectName !== undefined && /^(?:log|logger|auditLogger)$/i.test(objectName)) ||
          (object.type === 'MemberExpression' &&
            /^(?:log|logger)$/i.test(staticPropertyName(object) ?? ''));
        if (!isLoggerCall || node.arguments.length === 0) {
          return;
        }
        const [message] = node.arguments;
        const isStaticMessage =
          message?.type === 'Literal' && typeof message.value === 'string'
            ? true
            : message?.type === 'TemplateLiteral' && message.expressions.length === 0;
        if (!isStaticMessage) {
          context.report({ node: message ?? node, messageId: 'dynamic' });
        }
      },
    };
  },
};

export default rule;
