// @ts-check

import { identifierName, propertyValue, staticPropertyName, stringValue } from './ast-utils.mjs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @typedef {import('estree').Node & { parent?: import('estree').Node | null }} NodeWithParent */

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../');

/** @param {import('estree').Node} node */
function isImportBinding(node) {
  const parent = /** @type {NodeWithParent} */ (node).parent;
  return (
    parent?.type === 'ImportSpecifier' ||
    parent?.type === 'ImportDefaultSpecifier' ||
    parent?.type === 'ImportNamespaceSpecifier'
  );
}

/**
 * @param {import('eslint').SourceCode} sourceCode
 * @param {import('estree').Node} node
 * @param {string} bindingName
 * @param {ReadonlySet<object>} importedBindings
 */
function resolvesToImportedBinding(sourceCode, node, bindingName, importedBindings) {
  let currentScope = /** @type {import('eslint').Scope.Scope | null} */ (sourceCode.getScope(node));
  while (currentScope !== null) {
    const variable = currentScope.set.get(bindingName);
    if (variable) {
      return importedBindings.has(variable);
    }
    currentScope = currentScope.upper;
  }
  return false;
}

/** @param {import('eslint').SourceCode} sourceCode @param {import('estree').Node} node @param {ReadonlySet<object>} routeFunctions @param {ReadonlySet<object>} routeNamespaces */
function isDefineRouteCall(sourceCode, node, routeFunctions, routeNamespaces) {
  if (node.type !== 'CallExpression') {
    return false;
  }
  const directName = identifierName(node.callee);
  if (directName && resolvesToImportedBinding(sourceCode, node, directName, routeFunctions)) {
    return true;
  }
  return (
    node.callee.type === 'MemberExpression' &&
    staticPropertyName(node.callee) === 'defineRoute' &&
    node.callee.object.type === 'Identifier' &&
    resolvesToImportedBinding(sourceCode, node, node.callee.object.name, routeNamespaces)
  );
}

/** @param {string} sourcePath */
function isRouteDefinitionFile(sourcePath) {
  const filename = `/${sourcePath.replaceAll('\\', '/')}`;
  return (
    /\/apps\/web\/src\/modules\/[^/]+\/features\/[^/]+\/presentation\//.test(filename) ||
    /\/apps\/web\/src\/app\/api\/.+\/route\.ts$/.test(filename) ||
    /\/apps\/web\/src\/extensions\//.test(filename)
  );
}

/** @param {string} sourcePath */
function isApplicationSource(sourcePath) {
  const filename = `/${sourcePath.replaceAll('\\', '/')}`;
  return /(?:^|\/)apps\/[^/]+\/src\//.test(filename);
}

/** @param {string} sourcePath */
function isContractWebhookFile(sourcePath) {
  const filename = `/${sourcePath.replaceAll('\\', '/')}`;
  return /(?:^|\/)packages\/contracts\/src\/(?:.*\/)?webhooks(?:\/|$)/.test(filename);
}

/** @param {string | undefined} sourcePath */
function isWebhookSource(sourcePath) {
  return (
    typeof sourcePath === 'string' &&
    /(?:^|\/)webhooks(?:\/|$)/.test(sourcePath.replaceAll('\\', '/'))
  );
}

/** @param {string} importer @param {string} source */
function isCanonicalPlatformHttpSource(importer, source) {
  const normalized = source.replaceAll('\\', '/');
  if (normalized === '@/platform/http') {
    return true;
  }
  if (!normalized.startsWith('./') && !normalized.startsWith('../')) {
    return false;
  }
  const importerPath = resolve(repositoryRoot, importer);
  const resolved = resolve(dirname(importerPath), normalized);
  const canonical = resolve(repositoryRoot, 'apps/web/src/platform/http');
  return [
    `${canonical}.ts`,
    `${canonical}.tsx`,
    join(canonical, 'index.ts'),
    join(canonical, 'index.tsx'),
  ].includes(resolved);
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'restrict webhook payload schemas to authenticated webhook route inputs' },
    schema: [],
    messages: {
      import: 'Webhook schemas may only be imported by route-definition files.',
      route:
        'A webhook schema may only be used as input.body on a route with auth.kind = "webhook".',
      dynamic: 'Application source must use statically analyzable imports and requires.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    const program = sourceCode.ast;
    const allowedFile = isRouteDefinitionFile(context.filename);
    const appSource = isApplicationSource(context.filename);
    /** @type {Set<string>} */
    const webhookSchemaNames = new Set();
    /** @type {Set<string>} */
    const webhookNamespaces = new Set();
    /** @type {Set<object>} */
    const routeFunctionBindings = new Set();
    /** @type {Set<object>} */
    const routeNamespaceBindings = new Set();

    for (const statement of program.body) {
      if (statement.type !== 'ImportDeclaration') {
        continue;
      }
      const importPath = String(statement.source.value).replaceAll('\\', '/');
      if (isWebhookSource(importPath)) {
        if (!allowedFile) {
          context.report({ node: statement, messageId: 'import' });
        }
        for (const specifier of statement.specifiers) {
          if (specifier.type === 'ImportNamespaceSpecifier') {
            webhookNamespaces.add(specifier.local.name);
          } else {
            webhookSchemaNames.add(specifier.local.name);
          }
        }
      }
      if (isCanonicalPlatformHttpSource(context.filename, importPath)) {
        const moduleScope = sourceCode.getScope(statement);
        for (const specifier of statement.specifiers) {
          if (
            specifier.type === 'ImportSpecifier' &&
            specifier.imported.type === 'Identifier' &&
            specifier.imported.name === 'defineRoute'
          ) {
            const variable = moduleScope.set.get(specifier.local.name);
            if (variable) {
              routeFunctionBindings.add(variable);
            }
          } else if (specifier.type === 'ImportNamespaceSpecifier') {
            const variable = moduleScope.set.get(specifier.local.name);
            if (variable) {
              routeNamespaceBindings.add(variable);
            }
          }
        }
      }
    }

    /** @param {import('estree').Node} reference */
    function validateWebhookReference(reference) {
      if (!allowedFile) {
        return;
      }
      if (reference.type === 'Identifier' && isImportBinding(reference)) {
        return;
      }

      let current = /** @type {NodeWithParent} */ (reference);
      while (current.parent) {
        const parent = /** @type {NodeWithParent} */ (current.parent);
        if (
          parent.type === 'CallExpression' &&
          isDefineRouteCall(sourceCode, parent, routeFunctionBindings, routeNamespaceBindings)
        ) {
          const input = propertyValue(parent.arguments[0], 'input');
          const body = propertyValue(input, 'body');
          const isDirectBodyReference = body === reference;
          const auth = propertyValue(parent.arguments[0], 'auth');
          const kind = propertyValue(auth, 'kind');
          if (!isDirectBodyReference || stringValue(kind) !== 'webhook') {
            context.report({ node: reference, messageId: 'route' });
          }
          return;
        }
        if (
          parent.type === 'VariableDeclarator' ||
          parent.type === 'FunctionDeclaration' ||
          parent.type === 'ArrowFunctionExpression'
        ) {
          break;
        }
        current = parent;
      }
      context.report({ node: reference, messageId: 'route' });
    }

    return {
      Identifier(node) {
        if (webhookSchemaNames.has(node.name)) {
          validateWebhookReference(node);
        }
      },
      ExportNamedDeclaration(node) {
        if (
          node.source &&
          isWebhookSource(String(node.source.value)) &&
          !isContractWebhookFile(context.filename)
        ) {
          context.report({ node, messageId: 'import' });
        }
      },
      ExportAllDeclaration(node) {
        if (
          isWebhookSource(String(node.source.value)) &&
          !isContractWebhookFile(context.filename)
        ) {
          context.report({ node, messageId: 'import' });
        }
      },
      ImportExpression(node) {
        const source = stringValue(node.source);
        if (isWebhookSource(source)) {
          context.report({ node, messageId: 'import' });
        } else if (appSource && source === undefined) {
          context.report({ node, messageId: 'dynamic' });
        }
      },
      CallExpression(node) {
        const requireSource =
          node.callee.type === 'Identifier' && node.callee.name === 'require'
            ? stringValue(node.arguments[0])
            : undefined;
        if (
          appSource &&
          node.callee.type === 'Identifier' &&
          node.callee.name === 'require' &&
          requireSource === undefined
        ) {
          context.report({ node, messageId: 'dynamic' });
          return;
        }
        if (requireSource !== undefined && isWebhookSource(requireSource)) {
          context.report({ node, messageId: 'import' });
        }
      },
      MemberExpression(node) {
        if (node.object.type === 'Identifier' && webhookNamespaces.has(node.object.name)) {
          validateWebhookReference(node);
        }
      },
    };
  },
};

export default rule;
