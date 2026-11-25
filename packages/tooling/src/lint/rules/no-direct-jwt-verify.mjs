// @ts-check

import { isImportedNamespaceMember, stringValue } from './ast-utils.mjs';

const guardedJwtFunctions = new Set([
  'compactVerify',
  'decodeJwt',
  'decodeProtectedHeader',
  'flattenedVerify',
  'generalVerify',
  'jwtDecrypt',
  'jwtVerify',
]);

/** @param {string | undefined} source */
function isJoseModuleSource(source) {
  return source === 'jose' || source?.startsWith('jose/') === true;
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'centralize JWT verification in platform/auth' },
    schema: [],
    messages: {
      directJwt: 'JWT verification APIs from jose may only be imported inside platform/auth/.',
      accessToken: 'verifyAccessToken may only be imported by app/api/** or platform/**.',
    },
  },
  create(context) {
    const filename = `/${context.filename.replaceAll('\\', '/')}`;
    const allowedJwtVerifier = /\/apps\/web\/src\/platform\/auth(?:\/|$)/.test(filename);
    const allowedAccessToken =
      /\/apps\/web\/src\/app\/api(?:\/|$)/.test(filename) ||
      /\/apps\/web\/src\/platform(?:\/|$)/.test(filename);
    const program = context.sourceCode.ast;
    /** @type {Set<string>} */
    const joseNamespaces = new Set();
    /** @type {Set<string>} */
    const importedJwtFunctions = new Set();
    /** @type {Set<string>} */
    const accessTokenImports = new Set();
    /** @type {Set<string>} */
    const accessTokenNamespaces = new Set();

    for (const statement of program.body) {
      if (statement.type !== 'ImportDeclaration') {
        continue;
      }
      if (isJoseModuleSource(String(statement.source.value))) {
        for (const specifier of statement.specifiers) {
          if (specifier.type === 'ImportNamespaceSpecifier') {
            joseNamespaces.add(specifier.local.name);
          } else if (
            specifier.type === 'ImportSpecifier' &&
            specifier.imported.type === 'Identifier' &&
            guardedJwtFunctions.has(specifier.imported.name)
          ) {
            importedJwtFunctions.add(specifier.local.name);
            if (!allowedJwtVerifier) {
              context.report({ node: specifier, messageId: 'directJwt' });
            }
          }
        }
      }
      if (/(?:^|\/)platform\/auth(?:\/|$)/.test(String(statement.source.value))) {
        for (const specifier of statement.specifiers) {
          if (specifier.type === 'ImportNamespaceSpecifier') {
            accessTokenNamespaces.add(specifier.local.name);
          } else if (
            specifier.type === 'ImportSpecifier' &&
            specifier.imported.type === 'Identifier' &&
            specifier.imported.name === 'verifyAccessToken'
          ) {
            accessTokenImports.add(specifier.local.name);
            if (!allowedAccessToken) {
              context.report({ node: specifier, messageId: 'accessToken' });
            }
          }
        }
      }
    }

    return {
      CallExpression(node) {
        const requiredModule =
          node.callee.type === 'Identifier' && node.callee.name === 'require'
            ? stringValue(node.arguments[0])
            : undefined;
        if (isJoseModuleSource(requiredModule) && !allowedJwtVerifier) {
          context.report({ node, messageId: 'directJwt' });
        }
        if (
          requiredModule &&
          /(?:^|\/)platform\/auth(?:\/|$)/.test(requiredModule) &&
          !allowedAccessToken
        ) {
          context.report({ node, messageId: 'accessToken' });
        }
        if (
          node.callee.type === 'Identifier' &&
          importedJwtFunctions.has(node.callee.name) &&
          !allowedJwtVerifier
        ) {
          context.report({ node: node.callee, messageId: 'directJwt' });
        }
        for (const functionName of guardedJwtFunctions) {
          if (
            isImportedNamespaceMember(
              node.callee,
              joseNamespaces,
              importedJwtFunctions,
              functionName,
            ) &&
            !allowedJwtVerifier
          ) {
            context.report({ node: node.callee, messageId: 'directJwt' });
            break;
          }
        }
        if (
          node.callee.type === 'Identifier' &&
          accessTokenImports.has(node.callee.name) &&
          !allowedAccessToken
        ) {
          context.report({ node: node.callee, messageId: 'accessToken' });
        }
      },
      MemberExpression(node) {
        if (!allowedJwtVerifier) {
          for (const functionName of guardedJwtFunctions) {
            if (
              isImportedNamespaceMember(node, joseNamespaces, importedJwtFunctions, functionName)
            ) {
              context.report({ node, messageId: 'directJwt' });
              break;
            }
          }
        }
        if (
          isImportedNamespaceMember(node, accessTokenNamespaces, new Set(), 'verifyAccessToken') &&
          !allowedAccessToken
        ) {
          context.report({ node, messageId: 'accessToken' });
        }
      },
      ImportExpression(node) {
        const source = stringValue(node.source);
        if (isJoseModuleSource(source) && !allowedJwtVerifier) {
          context.report({ node, messageId: 'directJwt' });
        }
        if (source && /(?:^|\/)platform\/auth(?:\/|$)/.test(source) && !allowedAccessToken) {
          context.report({ node, messageId: 'accessToken' });
        }
      },
      ExportNamedDeclaration(node) {
        if (!node.source) {
          return;
        }
        const source = String(node.source.value);
        for (const specifier of node.specifiers) {
          if (
            isJoseModuleSource(source) &&
            specifier.type === 'ExportSpecifier' &&
            guardedJwtFunctions.has(
              specifier.local.type === 'Identifier'
                ? specifier.local.name
                : String(specifier.local.value),
            ) &&
            !allowedJwtVerifier
          ) {
            context.report({ node: specifier, messageId: 'directJwt' });
          }
          if (
            /(?:^|\/)platform\/auth(?:\/|$)/.test(source) &&
            specifier.type === 'ExportSpecifier' &&
            ((specifier.local.type === 'Identifier'
              ? specifier.local.name
              : String(specifier.local.value)) === 'verifyAccessToken' ||
              (specifier.exported.type === 'Identifier'
                ? specifier.exported.name
                : String(specifier.exported.value)) === 'verifyAccessToken') &&
            !allowedAccessToken
          ) {
            context.report({ node: specifier, messageId: 'accessToken' });
          }
        }
      },
      ExportAllDeclaration(node) {
        const source = String(node.source.value);
        if (isJoseModuleSource(source) && !allowedJwtVerifier) {
          context.report({ node, messageId: 'directJwt' });
        }
        if (/(?:^|\/)platform\/auth(?:\/|$)/.test(source) && !allowedAccessToken) {
          context.report({ node, messageId: 'accessToken' });
        }
      },
    };
  },
};

export default rule;
