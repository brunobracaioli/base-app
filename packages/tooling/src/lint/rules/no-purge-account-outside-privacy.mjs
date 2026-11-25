// @ts-check

import { staticPropertyName, stringValue } from './ast-utils.mjs';

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'limit purgeAccount imports to privacy and extension code' },
    schema: [],
    messages: {
      forbidden: 'purgeAccount may only be imported by modules/privacy/** or extensions/**.',
    },
  },
  create(context) {
    const filename = `/${context.filename.replaceAll('\\', '/')}`;
    const allowedImporter =
      /\/apps\/web\/src\/modules\/privacy\//.test(filename) ||
      /\/apps\/web\/src\/extensions\//.test(filename);
    /** @type {Set<string>} */
    const privacyNamespaces = new Set();

    return {
      ImportDeclaration(node) {
        if (allowedImporter || !/(?:^|\/)privacy(?:\/|$)/.test(String(node.source.value))) {
          return;
        }
        for (const specifier of node.specifiers) {
          if (
            specifier.type === 'ImportSpecifier' &&
            (specifier.imported.type === 'Identifier'
              ? specifier.imported.name
              : String(specifier.imported.value)) === 'purgeAccount'
          ) {
            context.report({ node: specifier, messageId: 'forbidden' });
          }
          if (specifier.type === 'ImportNamespaceSpecifier') {
            privacyNamespaces.add(specifier.local.name);
          }
        }
      },
      ExportNamedDeclaration(node) {
        if (
          allowedImporter ||
          !node.source ||
          !/(?:^|\/)privacy(?:\/|$)/.test(String(node.source.value))
        ) {
          return;
        }
        for (const specifier of node.specifiers) {
          if (
            specifier.type === 'ExportSpecifier' &&
            (specifier.local.type === 'Identifier'
              ? specifier.local.name
              : String(specifier.local.value)) === 'purgeAccount'
          ) {
            context.report({ node: specifier, messageId: 'forbidden' });
          } else if (
            specifier.type === 'ExportSpecifier' &&
            (specifier.exported.type === 'Identifier'
              ? specifier.exported.name
              : String(specifier.exported.value)) === 'purgeAccount'
          ) {
            context.report({ node: specifier, messageId: 'forbidden' });
          }
        }
      },
      ExportAllDeclaration(node) {
        if (!allowedImporter && /(?:^|\/)privacy(?:\/|$)/.test(String(node.source.value))) {
          context.report({ node, messageId: 'forbidden' });
        }
      },
      MemberExpression(node) {
        if (
          !allowedImporter &&
          node.object.type === 'Identifier' &&
          privacyNamespaces.has(node.object.name) &&
          staticPropertyName(node) === 'purgeAccount'
        ) {
          context.report({ node, messageId: 'forbidden' });
        }
      },
      ImportExpression(node) {
        const source = stringValue(node.source);
        if (!allowedImporter && source && /(?:^|\/)privacy(?:\/|$)/.test(source)) {
          context.report({ node, messageId: 'forbidden' });
        }
      },
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'require') {
          return;
        }
        const source = stringValue(node.arguments[0]);
        if (!allowedImporter && source && /(?:^|\/)privacy(?:\/|$)/.test(source)) {
          context.report({ node, messageId: 'forbidden' });
        }
      },
    };
  },
};

export default rule;
