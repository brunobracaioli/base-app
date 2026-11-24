// @ts-check

import ts from 'typescript';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';

const httpMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/** @param {string} projectRoot @param {string} importer @param {string} source */
function isPlatformHttpImport(projectRoot, importer, source) {
  const normalized = source.replaceAll('\\', '/');
  if (
    normalized !== '@/platform/http' &&
    !normalized.startsWith('./') &&
    !normalized.startsWith('../')
  ) {
    return false;
  }
  const resolved = resolveImport(projectRoot, importer, normalized);
  if (!resolved) {
    return false;
  }
  const canonical = resolve(projectRoot, 'apps/web/src/platform/http');
  return [
    `${canonical}.ts`,
    `${canonical}.tsx`,
    join(canonical, 'index.ts'),
    join(canonical, 'index.tsx'),
  ].includes(resolved);
}

/** @param {string} projectRoot @param {string} importer @param {string} source */
function resolveImport(projectRoot, importer, source) {
  let basePath;
  if (source.startsWith('@/')) {
    basePath = resolve(projectRoot, 'apps/web/src', source.slice(2));
  } else if (source.startsWith('apps/web/src/')) {
    basePath = resolve(projectRoot, source);
  } else if (source.startsWith('./') || source.startsWith('../')) {
    basePath = resolve(dirname(importer), source);
  } else {
    return null;
  }

  const candidates = extname(basePath)
    ? [basePath]
    : [
        `${basePath}.ts`,
        `${basePath}.tsx`,
        `${basePath}.mts`,
        `${basePath}.js`,
        join(basePath, 'index.ts'),
        join(basePath, 'index.tsx'),
        join(basePath, 'index.mts'),
        join(basePath, 'index.js'),
      ];
  return (
    candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null
  );
}

/** @param {string} projectRoot */
function createRouteChecker(projectRoot) {
  /** @type {Map<string, ts.SourceFile | null>} */
  const sourceFiles = new Map();

  /** @param {string} filePath */
  function sourceFile(filePath) {
    const normalized = resolve(filePath);
    if (sourceFiles.has(normalized)) {
      return sourceFiles.get(normalized) ?? null;
    }
    try {
      const file = ts.createSourceFile(
        normalized,
        readFileSync(normalized, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      sourceFiles.set(normalized, file);
      return file;
    } catch {
      sourceFiles.set(normalized, null);
      return null;
    }
  }

  /** @param {ts.SourceFile} file */
  function hasParseErrors(file) {
    const diagnostics =
      /** @type {ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }} */ (file)
        .parseDiagnostics;
    return (diagnostics?.length ?? 0) > 0;
  }

  /** @param {ts.Node} node */
  function hasExportModifier(node) {
    return (
      ts.canHaveModifiers(node) &&
      (ts.getModifiers(node) ?? []).some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      )
    );
  }

  /** @param {string} filePath @param {ts.Expression} expression @param {ts.SourceFile} file */
  function isDefineRouteCall(filePath, expression, file) {
    if (!ts.isCallExpression(expression)) {
      return false;
    }
    const imports = file.statements.filter(ts.isImportDeclaration);
    for (const declaration of imports) {
      if (
        !ts.isStringLiteral(declaration.moduleSpecifier) ||
        !isPlatformHttpImport(projectRoot, filePath, declaration.moduleSpecifier.text)
      ) {
        continue;
      }
      const bindings = declaration.importClause?.namedBindings;
      if (ts.isIdentifier(expression.expression)) {
        const calledName = expression.expression.text;
        if (
          bindings &&
          ts.isNamedImports(bindings) &&
          bindings.elements.some(
            (element) =>
              element.name.text === calledName &&
              (element.propertyName?.text ?? element.name.text) === 'defineRoute',
          )
        ) {
          return true;
        }
      }
      if (
        ts.isPropertyAccessExpression(expression.expression) &&
        ts.isIdentifier(expression.expression.expression) &&
        expression.expression.name.text === 'defineRoute' &&
        bindings &&
        ts.isNamespaceImport(bindings) &&
        bindings.name.text === expression.expression.expression.text
      ) {
        return true;
      }
    }
    return false;
  }

  /** @param {string} filePath @param {string} name @param {Set<string>} visited */
  function resolvesExport(filePath, name, visited) {
    const normalized = resolve(filePath);
    const visitKey = `${normalized}#${name}`;
    if (visited.has(visitKey)) {
      return false;
    }
    visited.add(visitKey);
    const file = sourceFile(normalized);
    if (!file || hasParseErrors(file)) {
      return false;
    }

    for (const statement of file.statements) {
      if (ts.isExportDeclaration(statement)) {
        const moduleSpecifier =
          statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
            ? statement.moduleSpecifier.text
            : undefined;
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) {
            if (element.name.text !== name) {
              continue;
            }
            const targetName = element.propertyName?.text ?? element.name.text;
            if (moduleSpecifier) {
              const target = resolveImport(projectRoot, normalized, moduleSpecifier);
              if (target && resolvesExport(target, targetName, visited)) {
                return true;
              }
            } else if (resolvesLocalBinding(normalized, targetName, visited)) {
              return true;
            }
          }
        } else if (moduleSpecifier) {
          const target = resolveImport(projectRoot, normalized, moduleSpecifier);
          if (target && resolvesExport(target, name, visited)) {
            return true;
          }
        }
      }

      if (!hasExportModifier(statement)) {
        continue;
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.name.text === name &&
            declaration.initializer
          ) {
            if (resolvesExpression(normalized, declaration.initializer, visited)) {
              return true;
            }
          }
        }
      } else if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
        return false;
      }
    }
    return false;
  }

  /** @param {string} filePath @param {string} name @param {Set<string>} visited */
  function resolvesLocalBinding(filePath, name, visited) {
    const file = sourceFile(filePath);
    if (!file) {
      return false;
    }
    for (const statement of file.statements) {
      if (ts.isImportDeclaration(statement)) {
        const source = ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : undefined;
        const target = source ? resolveImport(projectRoot, filePath, source) : null;
        if (!target) {
          continue;
        }
        const bindings = statement.importClause?.namedBindings;
        if (
          bindings &&
          ts.isNamedImports(bindings) &&
          bindings.elements.some((element) => element.name.text === name)
        ) {
          const element = bindings.elements.find((candidate) => candidate.name.text === name);
          if (
            element &&
            resolvesExport(target, element.propertyName?.text ?? element.name.text, visited)
          ) {
            return true;
          }
        }
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.name.text === name &&
            declaration.initializer
          ) {
            if (resolvesExpression(filePath, declaration.initializer, visited)) {
              return true;
            }
          }
        }
      }
    }
    return false;
  }

  /** @param {string} filePath @param {ts.Expression} expression @param {Set<string>} visited */
  function resolvesExpression(filePath, expression, visited) {
    const file = sourceFile(filePath);
    if (!file) {
      return false;
    }
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isSatisfiesExpression(expression)
    ) {
      return resolvesExpression(filePath, expression.expression, visited);
    }
    if (isDefineRouteCall(filePath, expression, file)) {
      return true;
    }
    if (ts.isIdentifier(expression)) {
      return resolvesLocalBinding(filePath, expression.text, visited);
    }
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
      for (const statement of file.statements) {
        if (!ts.isImportDeclaration(statement)) {
          continue;
        }
        const bindings = statement.importClause?.namedBindings;
        const source = ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : undefined;
        if (
          bindings &&
          ts.isNamespaceImport(bindings) &&
          bindings.name.text === expression.expression.text &&
          source
        ) {
          const target = resolveImport(projectRoot, filePath, source);
          if (target && resolvesExport(target, expression.name.text, visited)) {
            return true;
          }
        }
      }
    }
    return false;
  }

  return {
    /** @param {string} routeFile */
    check(routeFile) {
      const file = sourceFile(routeFile);
      if (!file || hasParseErrors(file)) {
        return ['Route file could not be parsed.'];
      }

      /** @type {Set<string>} */
      const handlerNames = new Set();
      for (const statement of file.statements) {
        if (
          ts.isExportDeclaration(statement) &&
          statement.exportClause &&
          ts.isNamedExports(statement.exportClause)
        ) {
          for (const element of statement.exportClause.elements) {
            if (httpMethods.has(element.name.text)) {
              handlerNames.add(element.name.text);
            }
          }
        }
        if (
          ts.isExportDeclaration(statement) &&
          !statement.exportClause &&
          statement.moduleSpecifier
        ) {
          const source = ts.isStringLiteral(statement.moduleSpecifier)
            ? statement.moduleSpecifier.text
            : undefined;
          const target = source ? resolveImport(projectRoot, routeFile, source) : null;
          if (target) {
            for (const method of httpMethods) {
              if (resolvesExport(target, method, new Set())) {
                handlerNames.add(method);
              }
            }
          }
        }
        if (hasExportModifier(statement) && ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name) && httpMethods.has(declaration.name.text)) {
              handlerNames.add(declaration.name.text);
            }
          }
        }
        if (
          hasExportModifier(statement) &&
          ts.isFunctionDeclaration(statement) &&
          statement.name &&
          httpMethods.has(statement.name.text)
        ) {
          handlerNames.add(statement.name.text);
        }
      }

      if (handlerNames.size === 0) {
        return ['No HTTP method handlers are exported.'];
      }

      const failures = [];
      for (const method of handlerNames) {
        if (!resolvesExport(routeFile, method, new Set())) {
          failures.push(`${method} is not created by an imported platform/http defineRoute.`);
        }
      }
      return failures;
    },
  };
}

/** @param {string} apiRoot */
function findRouteFiles(apiRoot) {
  /** @type {string[]} */
  const files = [];
  if (!existsSync(apiRoot)) {
    return files;
  }
  for (const entry of readdirSync(apiRoot)) {
    const fullPath = join(apiRoot, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      files.push(...findRouteFiles(fullPath));
    } else if (entry === 'route.ts') {
      files.push(fullPath);
    }
  }
  return files;
}

/** @param {string} projectRoot */
export function checkApiRouteHandlers(projectRoot) {
  const apiRoot = resolve(projectRoot, 'apps/web/src/app/api');
  const files = findRouteFiles(apiRoot);
  const checker = createRouteChecker(projectRoot);
  /** @type {string[]} */
  const failures = [];
  for (const file of files) {
    for (const issue of checker.check(file)) {
      failures.push(`${relative(projectRoot, file).replaceAll('\\', '/')}: ${issue}`);
    }
  }
  return { checked: files.length, failures };
}
