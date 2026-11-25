import { parse } from 'libpg-query';

type ObjectNode = Record<string, unknown>;
const auditInsert = /\binsert\s+into\s+"?audit"?\s*\.\s*"?events"?\b/i;
const approvedSignatures = new Map([
  ['app_config.set_setting', 'text,jsonb,text,text,text,timestamptz'],
  ['ops.purge_expired', ''],
  ['ops.purge_unconfirmed_users', ''],
]);

function object(value: unknown): ObjectNode {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectNode)
    : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string | undefined {
  const node = object(value);
  if (typeof node.sval === 'string') return node.sval;
  for (const child of Object.values(node)) {
    const found = string(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

function names(value: unknown): string {
  return list(value)
    .map((entry) => string(entry) ?? '')
    .join('.');
}

function typeName(value: unknown): string {
  return names(object(value).names).replace(/^pg_catalog\./, '');
}

function allowedFunction(value: unknown): boolean {
  const fn = object(value);
  const parameters = list(fn.parameters).map((entry) => object(object(entry).FunctionParameter));
  const signature = parameters.map((parameter) => typeName(parameter.argType)).join(',');
  if (approvedSignatures.get(names(fn.funcname)) !== signature) return false;
  if (parameters.some((p) => !['FUNC_PARAM_DEFAULT', 'FUNC_PARAM_IN'].includes(String(p.mode)))) {
    return false;
  }
  if (typeName(fn.returnType) !== 'void' || object(fn.returnType).setof === true) return false;
  const options = list(fn.options).map((entry) => object(object(entry).DefElem));
  const languages = options.filter((option) => option.defname === 'language');
  const security = options.filter((option) => option.defname === 'security');
  const paths = options.filter(
    (option) =>
      option.defname === 'set' && object(object(option.arg).VariableSetStmt).name === 'search_path',
  );
  const path = object(object(paths[0]?.arg).VariableSetStmt);
  return (
    languages.length === 1 &&
    string(languages[0]?.arg) === 'plpgsql' &&
    security.length === 1 &&
    object(object(security[0]?.arg).Boolean).boolval === true &&
    paths.length === 1 &&
    path.kind === 'VAR_SET_VALUE' &&
    list(path.args).length === 1 &&
    string(list(path.args)[0]) === ''
  );
}

function containsAuditInsert(value: unknown): boolean {
  if (typeof value === 'string') return auditInsert.test(value);
  if (Array.isArray(value)) return value.some(containsAuditInsert);
  const node = object(value);
  const relation = object(object(node.InsertStmt).relation);
  if (relation.schemaname === 'audit' && relation.relname === 'events') return true;
  return Object.values(node).some(containsAuditInsert);
}

/** Parse SQL boundaries so comments cannot forge an approved function context. */
export async function lintAuditWrites(source: string): Promise<string[]> {
  let tree: unknown;
  try {
    tree = await parse(source);
  } catch {
    return ['PostgreSQL parser rejected the migration.'];
  }
  const parsed = object(tree);
  if (
    typeof parsed.version !== 'number' ||
    Math.floor(parsed.version / 10000) !== 17 ||
    (parsed.stmts !== undefined && !Array.isArray(parsed.stmts))
  ) {
    return ['Unexpected PostgreSQL parser result.'];
  }
  const issues: string[] = [];
  for (const statement of list(parsed.stmts)) {
    const node = object(object(statement).stmt);
    if (!containsAuditInsert(node)) continue;
    if (node.CreateFunctionStmt !== undefined && allowedFunction(node.CreateFunctionStmt)) continue;
    issues.push(
      'Audit inserts require an approved core function signature, SECURITY DEFINER and empty search_path.',
    );
  }
  return issues;
}
