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
      if (!call || !ts.isCallExpression(call) || !ts.isObjectLiteralExpression(call.arguments[0]))
        continue;
      const auth = call.arguments[0].properties.find(
        (property) =>
          ts.isPropertyAssignment(property) &&
          ts.isIdentifier(property.name) &&
          property.name.text === 'auth',
      );
      const isPublic =
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
        );
      methods.push({ method: declaration.name.text.toLowerCase(), isPublic });
    }
  }
  return methods;
}

describe('API route and OpenAPI contracts', () => {
  it('requires every API route handler to come from platform/http defineRoute', () => {
    expect(checkApiRouteHandlers(projectRoot)).toEqual({ checked: 1, failures: [] });
  });

  it('keeps public route handlers identical to OpenAPI security: [] entries', () => {
    const routes = findRouteFiles(apiRoot);
    const actualPublic = routes.flatMap((routeFile) => {
      return exportedHttpMethods(routeFile)
        .filter((handler) => handler.isPublic)
        .map(
          (handler) =>
            `${handler.method} /${relative(apiRoot, routeFile)
              .replaceAll('\\', '/')
              .replace(/\/route\.ts$/, '')}`,
        );
    });
    const contracts = [...coreEndpoints, ...extensionEndpoints];
    const expectedPublic = contracts
      .filter((endpoint) => endpoint.security.length === 0)
      .map((endpoint) => `${endpoint.method} ${endpoint.path}`);
    expect(actualPublic.toSorted()).toEqual(expectedPublic.toSorted());
  });
});
