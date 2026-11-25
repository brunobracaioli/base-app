import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { coreEndpoints, extensionEndpoints } from '@base-app/contracts';
import { checkApiRouteHandlers } from '../../../../../packages/tooling/src/architecture/routes-use-define-route.mjs';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(testDirectory, '../../../../../');
const apiRoot = resolve(projectRoot, 'apps/web/src/app/api');

function findRouteFiles(directory: string): string[] {
  if (!statSync(directory).isDirectory()) return [];
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    return statSync(path).isDirectory() ? findRouteFiles(path) : entry === 'route.ts' ? [path] : [];
  });
}


function isPublicRouteObject(definition: ts.Expression | undefined): boolean {
  if (!definition || !ts.isObjectLiteralExpression(definition)) return false;
  const auth = definition.properties.find(
    (property) =>
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === 'auth',
  );
  return (
    auth !== undefined &&
    ts.isPropertyAssignment(auth) &&
    ts.isObjectLiteralExpression(auth.initializer) &&
    auth.initializer.properties.some(
      (property) =>
        ts.isPropertyAssignment(property) &&
        ts.isIdentifier(property.name) &&
        property.name.text === 'kind' &&
        ts.isStringLiteral(property.initializer) &&
        property.initializer.text === 'public',
    )
  );
}

function resolveRouteDefinitionObject(
  definition: ts.Expression | undefined,
  routeFile: string,
  visited = new Set<string>(),
): ts.Expression | undefined {
  if (!definition || !ts.isPropertyAccessExpression(definition)) return definition;
  if (!ts.isIdentifier(definition.expression)) return undefined;

  const localName = definition.expression.text;
  const propertyName = definition.name.text;
  const source = ts.createSourceFile(
    routeFile,
    readFileSync(routeFile, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    if (!bindings.elements.some((element) => element.name.text === localName)) continue;
    const modulePath = statement.moduleSpecifier.text;
    if (!modulePath.startsWith('.')) return undefined;
    const base = resolve(dirname(routeFile), modulePath);
    const target = [base, `${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts')].find(existsSync);
    if (!target || visited.has(target)) return undefined;
    visited.add(target);

    const importedSource = ts.createSourceFile(
      target,
      readFileSync(target, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    let found: ts.Expression | undefined;
    const findObject = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === propertyName &&
        node.initializer &&
        ts.isObjectLiteralExpression(node.initializer)
      ) {
        found = node.initializer;
        return;
      }
      ts.forEachChild(node, findObject);
    };
    findObject(importedSource);
    return found;
  }
  return undefined;
}

function exportedHttpMethods(
  filePath: string,
  visited = new Set<string>(),
): Array<{ readonly method: string; readonly isPublic: boolean }> {
  const canonicalPath = resolve(filePath);
  if (visited.has(canonicalPath)) return [];
  visited.add(canonicalPath);
  const source = ts.createSourceFile(
    canonicalPath,
    readFileSync(canonicalPath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const methods: Array<{ readonly method: string; readonly isPublic: boolean }> = [];
  for (const statement of source.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      const moduleSpecifier = statement.moduleSpecifier;
      if (
        !moduleSpecifier ||
        !ts.isStringLiteral(moduleSpecifier) ||
        !moduleSpecifier.text.startsWith('.')
      )
        continue;
      const base = resolve(dirname(canonicalPath), moduleSpecifier.text);
      const target = [base, `${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts')].find(
        existsSync,
      );
      if (!target) continue;
      const nested = exportedHttpMethods(target, visited);
      for (const exported of statement.exportClause.elements) {
        const targetName = (exported.propertyName?.text ?? exported.name.text).toLowerCase();
        const method = nested.find((entry) => entry.method === targetName);
        if (method)
          methods.push({ method: exported.name.text.toLowerCase(), isPublic: method.isPublic });
      }
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    const exported = (statement.modifiers ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (!exported) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        !['GET', 'POST', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(declaration.name.text)
      ) {
        continue;
      }
      const call = declaration.initializer;
      if (!call || !ts.isCallExpression(call)) continue;
      const definition = resolveRouteDefinitionObject(call.arguments[0], canonicalPath);
      const isPublic = isPublicRouteObject(definition);
      methods.push({ method: declaration.name.text.toLowerCase(), isPublic });
    }
  }
  return methods;
}

describe('API route and OpenAPI contracts', () => {
  it('requires every API route handler to come from platform/http defineRoute', () => {
    const result = checkApiRouteHandlers(projectRoot);
    expect(result.checked).toBeGreaterThan(0);
    expect(result.failures).toEqual([]);
  });

  it('keeps every API route method, path, and auth mode aligned with OpenAPI contracts', () => {
    const routes = findRouteFiles(apiRoot);
    const actual = routes.flatMap((routeFile) => {
      return exportedHttpMethods(routeFile).map((handler) => ({
        key: `${handler.method} /${relative(apiRoot, routeFile)
          .replaceAll('\\', '/')
          .replace(/\/route\.ts$/, '')}`,
        isPublic: handler.isPublic,
      }));
    });
    const contracts = [...coreEndpoints, ...extensionEndpoints];
    const expected = contracts.map((endpoint) => `${endpoint.method} ${endpoint.path}`);
    expect(actual.map(({ key }) => key).toSorted()).toEqual(expected.toSorted());
    for (const route of actual) {
      const contract = contracts.find(
        (endpoint) => `${endpoint.method} ${endpoint.path}` === route.key,
      );
      expect(contract, route.key).toBeDefined();
      expect(route.isPublic, route.key).toBe(contract?.security.length === 0);
    }
  });
});
