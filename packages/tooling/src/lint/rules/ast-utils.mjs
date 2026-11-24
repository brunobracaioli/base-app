// @ts-check

/** @typedef {import('estree').Node} Node */
/** @typedef {Node & { parent?: Node | null }} NodeWithParent */
/** @typedef {import('estree').Program} Program */
/** @typedef {import('estree').ImportDeclaration} ImportDeclaration */
/** @typedef {import('estree').ImportSpecifier} ImportSpecifier */
/** @typedef {import('estree').ImportDefaultSpecifier} ImportDefaultSpecifier */
/** @typedef {import('estree').ImportNamespaceSpecifier} ImportNamespaceSpecifier */

/** @param {Node | null | undefined} node */
export function identifierName(node) {
  return node?.type === 'Identifier' ? node.name : undefined;
}

/** @param {Node | null | undefined} node */
export function staticPropertyName(node) {
  if (node?.type !== 'MemberExpression') {
    return undefined;
  }
  if (!node.computed && node.property.type === 'Identifier') {
    return node.property.name;
  }
  if (
    node.computed &&
    node.property.type === 'Literal' &&
    typeof node.property.value === 'string'
  ) {
    return node.property.value;
  }
  return undefined;
}

/** @param {Program} program @param {string} sourceName */
export function importedLocals(program, sourceName) {
  /** @type {Map<string, string>} */
  const named = new Map();
  /** @type {Set<string>} */
  const namespace = new Set();

  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration' || statement.source.value !== sourceName) {
      continue;
    }
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportSpecifier') {
        const importedName =
          specifier.imported.type === 'Identifier'
            ? specifier.imported.name
            : String(specifier.imported.value);
        named.set(specifier.local.name, importedName);
      } else if (specifier.type === 'ImportDefaultSpecifier') {
        named.set(specifier.local.name, 'default');
      } else if (specifier.type === 'ImportNamespaceSpecifier') {
        namespace.add(specifier.local.name);
      }
    }
  }

  return { named, namespace };
}

/** @param {Node | null | undefined} node @param {ReadonlySet<string>} names */
export function isIdentifierIn(node, names) {
  return node?.type === 'Identifier' && names.has(node.name);
}

/** @param {Node | null | undefined} node */
export function stringValue(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') {
    return node.value;
  }
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

/** @param {Node | null | undefined} node @param {string} propertyName */
export function propertyValue(node, propertyName) {
  if (node?.type !== 'ObjectExpression') {
    return undefined;
  }
  for (const property of node.properties) {
    if (property.type !== 'Property' || property.computed) {
      continue;
    }
    const key =
      property.key.type === 'Identifier'
        ? property.key.name
        : property.key.type === 'Literal'
          ? String(property.key.value)
          : undefined;
    if (key === propertyName) {
      return property.value;
    }
  }
  return undefined;
}

/** @param {Node} node */
export function isTopLevelVariableInitializer(node) {
  let current = /** @type {NodeWithParent} */ (node);
  while (current.parent) {
    const parent = /** @type {NodeWithParent} */ (current.parent);
    if (parent.type === 'MemberExpression' && parent.object === current) {
      current = parent;
      continue;
    }
    if (parent.type === 'CallExpression' && parent.callee === current) {
      current = parent;
      continue;
    }
    if (parent.type === 'VariableDeclarator' && parent.init === current) {
      const declaration = parent.parent ? /** @type {NodeWithParent} */ (parent.parent) : undefined;
      const owner = declaration?.parent
        ? /** @type {NodeWithParent} */ (declaration.parent)
        : undefined;
      return (
        declaration?.type === 'VariableDeclaration' &&
        (owner?.type === 'Program' || owner?.type === 'ExportNamedDeclaration')
      );
    }
    return false;
  }
  return false;
}

/** @param {Node} node @param {string} methodName */
export function hasChainedMethod(node, methodName) {
  let current = /** @type {NodeWithParent} */ (node);
  while (current.parent) {
    const parent = /** @type {NodeWithParent} */ (current.parent);
    if (parent.type === 'MemberExpression' && parent.object === current) {
      const method = staticPropertyName(parent);
      if (method === methodName && parent.parent?.type === 'CallExpression') {
        return true;
      }
      current = parent;
      continue;
    }
    if (parent.type === 'CallExpression' && parent.callee === current) {
      current = parent;
      continue;
    }
    break;
  }
  return false;
}

/** @param {Node} node @param {ReadonlySet<string>} namespaceImports @param {ReadonlySet<string>} zBindings */
export function isZodNamespace(node, namespaceImports, zBindings) {
  if (node.type === 'Identifier') {
    return namespaceImports.has(node.name) || zBindings.has(node.name);
  }
  return (
    node.type === 'MemberExpression' &&
    staticPropertyName(node) === 'z' &&
    node.object.type === 'Identifier' &&
    namespaceImports.has(node.object.name)
  );
}

/** @param {Program} program */
export function zodBindings(program) {
  /** @type {Set<string>} */
  const namespaceImports = new Set();
  /** @type {Set<string>} */
  const zBindings = new Set();
  /** @type {Set<string>} */
  const objectFactories = new Set();

  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration' || statement.source.value !== 'zod') {
      continue;
    }
    for (const specifier of statement.specifiers) {
      if (
        specifier.type === 'ImportNamespaceSpecifier' ||
        specifier.type === 'ImportDefaultSpecifier'
      ) {
        namespaceImports.add(specifier.local.name);
      } else if (specifier.type === 'ImportSpecifier') {
        const importedName =
          specifier.imported.type === 'Identifier'
            ? specifier.imported.name
            : String(specifier.imported.value);
        if (importedName === 'z') {
          zBindings.add(specifier.local.name);
        }
        if (
          importedName === 'object' ||
          importedName === 'looseObject' ||
          importedName === 'strictObject'
        ) {
          objectFactories.add(specifier.local.name);
        }
      }
    }
  }

  return { namespaceImports, zBindings, objectFactories };
}

/** @param {Node} callee @param {ReturnType<typeof zodBindings>} bindings */
export function zodObjectFactory(callee, bindings) {
  if (callee.type === 'Identifier') {
    return bindings.objectFactories.has(callee.name) ? callee.name : undefined;
  }
  if (callee.type !== 'MemberExpression') {
    return undefined;
  }
  const member = staticPropertyName(callee);
  if (member !== 'object' && member !== 'looseObject' && member !== 'strictObject') {
    return undefined;
  }
  return isZodNamespace(callee.object, bindings.namespaceImports, bindings.zBindings)
    ? member
    : undefined;
}

/** @param {Node} callee @param {ReadonlySet<string>} namespaceImports @param {ReadonlySet<string>} namedBindings @param {string} exportName */
export function isImportedNamespaceMember(callee, namespaceImports, namedBindings, exportName) {
  if (callee.type !== 'MemberExpression' || staticPropertyName(callee) !== exportName) {
    return false;
  }
  if (callee.object.type === 'Identifier' && namespaceImports.has(callee.object.name)) {
    return true;
  }
  return namedBindings.has(identifierName(callee.object) ?? '');
}

/** @param {ImportDeclaration} declaration @param {string} importedName */
export function matchingImportSpecifiers(declaration, importedName) {
  return declaration.specifiers.filter(
    (specifier) =>
      specifier.type === 'ImportSpecifier' &&
      (specifier.imported.type === 'Identifier'
        ? specifier.imported.name
        : String(specifier.imported.value)) === importedName,
  );
}
