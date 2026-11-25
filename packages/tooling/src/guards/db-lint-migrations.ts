import { access, lstat, readdir, readFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { parse as parsePostgresSql } from 'libpg-query';
import { z } from 'zod';
import {
  parseCoreAuthFunctionRegistryDocument,
  type CoreAuthFunctionRegistryEntry,
} from '../db/core-auth-function-registry.js';

type JsonObject = Record<string, unknown>;
type PgName = readonly string[];

const protectedSchemas = new Set([
  'identity',
  'privacy',
  'app_config',
  'platform',
  'audit',
  'ops',
  'auth',
  'public',
]);

const allowedCoreGroupRoles = new Set([
  'audit_writer',
  'audit_operator_writer',
  'audit_reader',
  'app_config_writer',
]);

const groupMemberArraySchema = z
  .array(z.string().regex(/^[a-z][a-z0-9_]*$/))
  .refine((members) => new Set(members).size === members.length, 'duplicate member');

const expectedGroupMembersSchema = z
  .object({
    audit_writer: groupMemberArraySchema.optional(),
    audit_operator_writer: groupMemberArraySchema.optional(),
    audit_reader: groupMemberArraySchema.optional(),
    app_config_writer: groupMemberArraySchema.optional(),
  })
  .strict();

export class MigrationLintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationLintError';
  }
}

export type CoreAuthFunctionRegistration = CoreAuthFunctionRegistryEntry;

export interface MigrationLintIssue {
  readonly code: string;
  readonly message: string;
  readonly statement: number;
}

export interface CoreAuthFunctionLintIssue extends MigrationLintIssue {
  readonly migration: string;
}

export interface ExtensionMigration {
  readonly name: string;
  readonly contents: string;
}

export interface ExtensionMigrationLintOptions {
  readonly registeredGroupRoles?: ReadonlyMap<string, ReadonlySet<string>>;
  readonly knownPrimaryKeyColumns?: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface ExtensionMigrationLintResult {
  readonly isExtensionMigration: boolean;
  readonly extensionSchema: string | null;
  readonly issues: readonly MigrationLintIssue[];
  readonly knownPrimaryKeyColumns: ReadonlyMap<string, ReadonlySet<string>>;
}

interface ParsedStatement {
  stmt?: unknown;
  stmt_location?: number;
  stmt_len?: number;
}

interface ParsedSql {
  version?: number;
  stmts?: ParsedStatement[];
}

interface NodeVariant {
  readonly tag: string;
  readonly payload: JsonObject;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nodeVariant(value: unknown): NodeVariant | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length !== 1 || !isRecord(entries[0]?.[1])) return null;
  const [tag, payload] = entries[0] as [string, JsonObject];
  return { tag, payload };
}

function getNodeValue(value: unknown, key: string): unknown {
  if (!isRecord(value)) return undefined;
  const wrapped = nodeVariant(value);
  const source = wrapped?.payload ?? value;
  return source[key];
}

function nodeArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const variant = nodeVariant(value);
  if (variant?.tag === 'List' && Array.isArray(variant.payload.items)) return variant.payload.items;
  return [];
}

function stringsFromName(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((entry) => stringsFromName(entry));
  if (!isRecord(value)) return [];

  const variant = nodeVariant(value);
  if (variant !== null) {
    if (variant.tag === 'String' && typeof variant.payload.sval === 'string')
      return [variant.payload.sval];
    if (variant.tag === 'List') return stringsFromName(variant.payload.items);
    if (variant.tag === 'ObjectWithArgs') return stringsFromName(variant.payload.objname);
    if (variant.tag === 'RoleSpec' && typeof variant.payload.rolename === 'string')
      return [variant.payload.rolename];
    if (variant.tag === 'RangeVar') return stringsFromName(variant.payload);
    if (variant.tag === 'AccessPriv' && typeof variant.payload.priv_name === 'string')
      return [variant.payload.priv_name];
    return [];
  }

  if (typeof value.relname === 'string') {
    return typeof value.schemaname === 'string'
      ? [value.schemaname, value.relname]
      : [value.relname];
  }
  if (typeof value.sval === 'string') return [value.sval];
  if (typeof value.rolename === 'string') return [value.rolename];
  if (Array.isArray(value.objname)) return stringsFromName(value.objname);
  if (Array.isArray(value.items)) return stringsFromName(value.items);
  return [];
}

function relationSchema(value: unknown): string | null {
  if (!isRecord(value) || typeof value.relname !== 'string') return null;
  return typeof value.schemaname === 'string' ? value.schemaname : 'public';
}

function schemaForQualifiedName(parts: PgName, objectType: unknown): string | null {
  if (parts.length === 0) return null;
  if (objectType === 'OBJECT_SCHEMA') return parts[0] ?? null;
  return parts.length > 1 ? (parts[0] ?? null) : 'public';
}

function isProtectedSchema(schema: string | null): boolean {
  return schema !== null && protectedSchemas.has(schema);
}

function targetIsProtected(relation: unknown): boolean {
  return isProtectedSchema(relationSchema(relation));
}

function stringValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  const variant = nodeVariant(value);
  if (variant?.tag === 'String' && typeof variant.payload.sval === 'string')
    return variant.payload.sval;
  if (isRecord(value) && typeof value.sval === 'string') return value.sval;
  return null;
}

function booleanValue(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  const variant = nodeVariant(value);
  if (variant?.tag === 'Boolean' && typeof variant.payload.boolval === 'boolean')
    return variant.payload.boolval;
  return null;
}

function arrayContainsOnlyEmptyOrUndefined(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length === 0);
}

function extensionSchemaFromFilename(filename: string): string | null {
  const match = path.basename(filename).match(/^\d+_ext-([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)_.+\.sql$/);
  return match?.[1]?.replaceAll('-', '_') ?? null;
}

function isMalformedExtensionMigrationName(filename: string): boolean {
  return (
    path.basename(filename).includes('_ext-') && extensionSchemaFromFilename(filename) === null
  );
}

export interface DerivedMigrationNamePolicyInput {
  readonly declaredDerived: boolean;
  readonly localMigrationNames: readonly string[];
  readonly upstreamMigrationNames?: ReadonlySet<string>;
  readonly changedMigrationNames?: ReadonlySet<string>;
}

export interface DerivedRepositorySignals {
  readonly bootstrapFilePresent: boolean;
  readonly upstreamRemotePresent: boolean;
  readonly upstreamMainRefPresent: boolean;
}

export function resolveDerivedRepositoryMode(signals: DerivedRepositorySignals): boolean {
  const declaredDerived =
    signals.bootstrapFilePresent || signals.upstreamRemotePresent || signals.upstreamMainRefPresent;
  if (declaredDerived && !signals.upstreamMainRefPresent) {
    throw new MigrationLintError(
      'This derived repository requires upstream/main to be available for migration policy checks.',
    );
  }
  return declaredDerived;
}

export function validateDerivedMigrationNames(
  input: DerivedMigrationNamePolicyInput,
): readonly string[] {
  if (!input.declaredDerived) return [];
  if (input.upstreamMigrationNames === undefined) {
    throw new MigrationLintError(
      'This derived repository requires upstream/main to be available for migration policy checks.',
    );
  }

  const problems: string[] = [];
  const localNames = new Set(input.localMigrationNames.map((name) => path.basename(name)));
  for (const rawName of input.localMigrationNames) {
    const filename = path.basename(rawName);
    const isExtension = extensionSchemaFromFilename(filename) !== null;
    if (isMalformedExtensionMigrationName(filename)) {
      problems.push(
        `${filename} contains _ext- but does not match the extension migration naming contract.`,
      );
      continue;
    }
    const existsUpstream = input.upstreamMigrationNames.has(filename);
    const changed = input.changedMigrationNames?.has(filename) ?? false;
    if (existsUpstream && changed) {
      problems.push(
        `${filename} changes an upstream migration; applied migrations are immutable in derived repositories.`,
      );
      continue;
    }
    if (!existsUpstream && !isExtension) {
      problems.push(
        `${filename} is new relative to upstream/main and must use the _ext-<extension>_ filename prefix.`,
      );
    }
  }
  for (const upstreamName of input.upstreamMigrationNames) {
    if (!localNames.has(upstreamName))
      problems.push(
        `${upstreamName} from upstream/main is missing locally; merge the upstream migration set.`,
      );
  }
  return problems;
}

function addIssue(
  issues: MigrationLintIssue[],
  code: string,
  message: string,
  statement: number,
): void {
  issues.push({ code, message, statement });
}

function objectTypeFor(nodeType: string, payload: JsonObject): unknown {
  return payload.objtype ?? payload.objectType ?? payload.removeType ?? payload.kind ?? nodeType;
}

function getDefinitionName(payload: JsonObject): string | null {
  const parts = stringsFromName(payload.funcname);
  return parts.length > 0 ? parts.join('.') : null;
}

function getFunctionSignature(payload: JsonObject): string {
  const parameters = nodeArray(payload.parameters);
  const types: string[] = [];
  for (const parameter of parameters) {
    const mode = stringValue(getNodeValue(parameter, 'mode'));
    if (mode === 'FUNC_PARAM_OUT' || mode === 'FUNC_PARAM_TABLE') continue;
    const parameterType = getNodeValue(parameter, 'argType');
    const name = stringsFromName(getNodeValue(parameterType, 'names'));
    types.push(name.join('.'));
  }
  return `(${types.join(',')})`;
}

function functionOptions(payload: JsonObject): {
  securityDefiner: boolean;
  emptySearchPath: boolean;
} {
  let securityDefiner = false;
  let emptySearchPath = false;
  for (const option of nodeArray(payload.options)) {
    const optionPayload =
      getNodeValue(option, 'defname') === undefined ? null : nodeVariant(option);
    if (optionPayload?.tag !== 'DefElem') continue;
    const name = stringValue(optionPayload.payload.defname);
    const argument = optionPayload.payload.arg;
    if (name === 'security')
      securityDefiner = booleanValue(getNodeValue(argument, 'boolval')) === true;
    if (name === 'set') {
      const setPayload = nodeVariant(argument);
      if (setPayload?.tag !== 'VariableSetStmt' || setPayload.payload.name !== 'search_path')
        continue;
      const args = nodeArray(setPayload.payload.args);
      const first = args[0];
      const value = getNodeValue(first, 'sval');
      emptySearchPath = stringValue(value) === '';
    }
  }
  return { securityDefiner, emptySearchPath };
}

interface ForeignKeyNode {
  readonly constraint: JsonObject;
  readonly inlineColumn: string | null;
}

function createTableConstraints(payload: JsonObject): ForeignKeyNode[] {
  const constraints: ForeignKeyNode[] = [];
  for (const element of nodeArray(payload.tableElts)) {
    const elementNode = nodeVariant(element);
    if (elementNode?.tag === 'Constraint' && elementNode.payload.contype === 'CONSTR_FOREIGN') {
      constraints.push({ constraint: elementNode.payload, inlineColumn: null });
    }
    const columnName = getNodeValue(element, 'colname');
    for (const constraintNode of nodeArray(getNodeValue(element, 'constraints'))) {
      const constraint = nodeVariant(constraintNode);
      if (constraint?.tag === 'Constraint' && constraint.payload.contype === 'CONSTR_FOREIGN') {
        constraints.push({
          constraint: constraint.payload,
          inlineColumn: typeof columnName === 'string' ? columnName : null,
        });
      }
    }
  }
  for (const constraintNode of nodeArray(payload.constraints)) {
    const constraint = nodeVariant(constraintNode);
    if (constraint?.tag === 'Constraint' && constraint.payload.contype === 'CONSTR_FOREIGN') {
      constraints.push({ constraint: constraint.payload, inlineColumn: null });
    }
  }
  return constraints;
}

function createTablePrimaryKeys(payload: JsonObject): ReadonlySet<string> {
  const primaryKeys = new Set<string>();
  for (const element of nodeArray(payload.tableElts)) {
    const elementNode = nodeVariant(element);
    const columnName = getNodeValue(element, 'colname');
    const constraints = [
      ...(elementNode?.tag === 'Constraint' ? [elementNode] : []),
      ...nodeArray(getNodeValue(element, 'constraints'))
        .map((node) => nodeVariant(node))
        .filter((node): node is NodeVariant => node !== null),
    ];
    for (const constraint of constraints) {
      if (constraint.tag !== 'Constraint' || constraint.payload.contype !== 'CONSTR_PRIMARY')
        continue;
      if (typeof columnName === 'string') primaryKeys.add(columnName);
      for (const key of stringsFromName(constraint.payload.keys)) primaryKeys.add(key);
    }
  }
  for (const constraintNode of nodeArray(payload.constraints)) {
    const constraint = nodeVariant(constraintNode);
    if (constraint?.tag === 'Constraint' && constraint.payload.contype === 'CONSTR_PRIMARY') {
      for (const key of stringsFromName(constraint.payload.keys)) primaryKeys.add(key);
    }
  }
  return primaryKeys;
}

function relationKey(relation: unknown): string | null {
  if (!isRecord(relation) || typeof relation.relname !== 'string') return null;
  return `${typeof relation.schemaname === 'string' ? relation.schemaname : 'public'}.${relation.relname}`;
}

function foreignKeyTargetsProtectedSchema(
  constraint: JsonObject,
  localColumns: ReadonlySet<string>,
): boolean {
  const target = constraint.pktable;
  const schema = relationSchema(target);
  if (schema === null || !protectedSchemas.has(schema)) return false;
  const table = isRecord(target) ? target.relname : undefined;
  const referencedColumns = stringsFromName(constraint.pk_attrs);
  return (
    schema !== 'auth' ||
    table !== 'users' ||
    referencedColumns.length !== 1 ||
    referencedColumns[0] !== 'id' ||
    localColumns.size !== 1
  );
}

function createTableHasForbiddenCoreForeignKey(payload: JsonObject): boolean {
  const primaryKeys = createTablePrimaryKeys(payload);
  return createTableConstraints(payload).some(({ constraint, inlineColumn }) => {
    const foreignColumns = stringsFromName(constraint.fk_attrs);
    const localColumns =
      foreignColumns.length > 0 ? foreignColumns : inlineColumn === null ? [] : [inlineColumn];
    if (foreignKeyTargetsProtectedSchema(constraint, new Set(localColumns))) return true;
    const schema = relationSchema(constraint.pktable);
    return schema === 'auth' && !localColumns.every((column) => primaryKeys.has(column));
  });
}

function alterTableHasForbiddenCoreForeignKey(
  payload: JsonObject,
  knownPrimaryKeyColumns: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const table = relationKey(payload.relation);
  let provenPrimaryKey = new Set(table === null ? [] : (knownPrimaryKeyColumns.get(table) ?? []));
  for (const command of nodeArray(payload.cmds)) {
    const subtype = getNodeValue(command, 'subtype');
    if (typeof subtype === 'string' && subtype.startsWith('AT_DropConstraint'))
      provenPrimaryKey = new Set();
    const constraint = nodeVariant(getNodeValue(command, 'def'));
    if (constraint?.tag === 'Constraint' && constraint.payload.contype === 'CONSTR_PRIMARY') {
      provenPrimaryKey = new Set(stringsFromName(constraint.payload.keys));
    }
  }
  return nodeArray(payload.cmds).some((command) => {
    const constraintNode = getNodeValue(command, 'def');
    const constraint = nodeVariant(constraintNode);
    if (constraint?.tag !== 'Constraint' || constraint.payload.contype !== 'CONSTR_FOREIGN')
      return false;
    const foreignColumns = stringsFromName(constraint.payload.fk_attrs);
    if (foreignKeyTargetsProtectedSchema(constraint.payload, new Set(foreignColumns))) return true;
    const schema = relationSchema(constraint.payload.pktable);
    return (
      schema === 'auth' &&
      (foreignColumns.length !== 1 ||
        provenPrimaryKey.size !== 1 ||
        !foreignColumns.every((column) => provenPrimaryKey.has(column)))
    );
  });
}

function updatePrimaryKeyMetadata(
  statement: NodeVariant,
  extensionSchema: string,
  primaryKeys: Map<string, ReadonlySet<string>>,
): void {
  const payload = statement.payload;
  if (statement.tag === 'CreateStmt') {
    const table = relationKey(payload.relation);
    if (table !== null && relationSchema(payload.relation) === extensionSchema) {
      primaryKeys.set(table, createTablePrimaryKeys(payload));
    }
    return;
  }
  if (statement.tag !== 'AlterTableStmt') return;
  const table = relationKey(payload.relation);
  if (table === null || relationSchema(payload.relation) !== extensionSchema) return;
  let current = new Set(primaryKeys.get(table) ?? []);
  for (const command of nodeArray(payload.cmds)) {
    const subtype = getNodeValue(command, 'subtype');
    if (typeof subtype === 'string' && subtype.startsWith('AT_DropConstraint')) current = new Set();
    const constraint = nodeVariant(getNodeValue(command, 'def'));
    if (constraint?.tag === 'Constraint' && constraint.payload.contype === 'CONSTR_PRIMARY') {
      current = new Set(stringsFromName(constraint.payload.keys));
    }
  }
  primaryKeys.set(table, current);
}

function extensionLocalDdlSchema(nodeType: string, payload: JsonObject): string | null {
  switch (nodeType) {
    case 'CreateStmt':
      return relationSchema(payload.relation);
    case 'CreateSeqStmt':
      return relationSchema(payload.sequence);
    case 'AlterSeqStmt':
      return relationSchema(payload.sequence);
    case 'IndexStmt':
      return relationSchema(payload.relation);
    case 'CreateTrigStmt':
      return relationSchema(payload.relation);
    case 'CreatePolicyStmt':
    case 'AlterPolicyStmt':
      return relationSchema(payload.table);
    case 'AlterTableStmt':
      return relationSchema(payload.relation);
    case 'CreateFunctionStmt': {
      const name = stringsFromName(payload.funcname);
      return name.length > 1 ? (name[0] ?? null) : 'public';
    }
    case 'CreateSchemaStmt':
      return typeof payload.schemaname === 'string' ? payload.schemaname : null;
    case 'CreateForeignTableStmt':
      return relationSchema(getNodeValue(payload.base, 'relation'));
    case 'ViewStmt':
    case 'CreateViewStmt':
      return relationSchema(payload.view);
    case 'CreateTableAsStmt': {
      const into = payload.into;
      return relationSchema(getNodeValue(into, 'rel'));
    }
    case 'CreateDomainStmt': {
      const name = stringsFromName(payload.domainname);
      return name.length > 1 ? (name[0] ?? null) : 'public';
    }
    case 'DefineStmt':
    case 'CreateOpClassStmt':
    case 'CreateOpFamilyStmt': {
      const name = stringsFromName(payload.defnames ?? payload.opclassname ?? payload.opfamilyname);
      return name.length > 1 ? (name[0] ?? null) : 'public';
    }
    default:
      return null;
  }
}

function checkRoleGrant(
  payload: JsonObject,
  extensionSchema: string,
  registeredGroupRoles: ReadonlyMap<string, ReadonlySet<string>>,
): string | null {
  if (payload.is_grant !== true || !arrayContainsOnlyEmptyOrUndefined(payload.opt))
    return 'Only a plain GRANT of a permitted core group role is allowed in extension migrations.';
  const grantedRoles = nodeArray(payload.granted_roles)
    .map((value) => {
      const node = nodeVariant(value);
      if (node?.tag === 'AccessPriv' && typeof node.payload.priv_name === 'string')
        return node.payload.priv_name;
      return stringValue(value);
    })
    .filter((value): value is string => value !== null);
  const grantees = nodeArray(payload.grantee_roles)
    .map((value) => {
      const role = nodeVariant(value);
      return role?.tag === 'RoleSpec' && typeof role.payload.rolename === 'string'
        ? role.payload.rolename
        : null;
    })
    .filter((value): value is string => value !== null);
  if (
    grantedRoles.length !== 1 ||
    !allowedCoreGroupRoles.has(grantedRoles[0] ?? '') ||
    grantees.length === 0
  ) {
    return 'Only the declared audit/app-config group roles may be granted by an extension migration.';
  }
  for (const grantee of grantees) {
    const isSystem = grantee === `${extensionSchema}_system`;
    const groupRole = grantedRoles[0] ?? '';
    const isDeclaredAuxiliary =
      grantee.startsWith(`${extensionSchema}_`) &&
      (registeredGroupRoles.get(groupRole)?.has(grantee) ?? false);
    if (!isSystem && !isDeclaredAuxiliary)
      return `Role grant target ${grantee} must be ${extensionSchema}_system or a declared ${extensionSchema}_ auxiliary role.`;
  }
  return null;
}

function hasFunctionOwnerTransfer(
  statements: readonly ParsedStatement[],
  qualifiedName: string,
  signature: string,
  ownerName: string,
): boolean {
  return statements.some((statement) => {
    const ownerChange = nodeVariant(statement.stmt);
    if (
      ownerChange?.tag !== 'AlterOwnerStmt' ||
      ownerChange.payload.objectType !== 'OBJECT_FUNCTION'
    )
      return false;
    if (
      !isRecord(ownerChange.payload.newowner) ||
      ownerChange.payload.newowner.rolename !== ownerName
    )
      return false;
    const object = nodeVariant(ownerChange.payload.object);
    if (object?.tag !== 'ObjectWithArgs') return false;
    const name = stringsFromName(object.payload.objname).join('.');
    const args = `(${nodeArray(object.payload.objargs)
      .map((arg) => stringsFromName(getNodeValue(arg, 'names')).join('.'))
      .join(',')})`;
    return name === qualifiedName && args === signature;
  });
}

function functionOwnerTransfer(
  statement: ParsedStatement,
): { readonly name: string; readonly signature: string; readonly owner: string } | null {
  const ownerChange = nodeVariant(statement.stmt);
  if (
    ownerChange?.tag !== 'AlterOwnerStmt' ||
    ownerChange.payload.objectType !== 'OBJECT_FUNCTION' ||
    !isRecord(ownerChange.payload.newowner) ||
    typeof ownerChange.payload.newowner.rolename !== 'string'
  )
    return null;
  const object = nodeVariant(ownerChange.payload.object);
  if (object?.tag !== 'ObjectWithArgs') return null;
  const nameParts = stringsFromName(object.payload.objname);
  if (nameParts.length === 0 || nameParts.length > 2) return null;
  const signature = `(${nodeArray(object.payload.objargs)
    .map((arg) => stringsFromName(getNodeValue(arg, 'names')).join('.'))
    .join(',')})`;
  return {
    name: nameParts.length === 1 ? `public.${nameParts[0]}` : nameParts.join('.'),
    signature,
    owner: ownerChange.payload.newowner.rolename,
  };
}

function coreAuthFunctionIdentity(schema: string, name: string, signature: string): string {
  return `${schema}.${name}${signature.replaceAll(' ', '')}`;
}

function hasNamedRole(value: unknown, roleName: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => hasNamedRole(entry, roleName));
  if (!isRecord(value)) return false;
  if (
    (value.rolename === roleName || value.role === roleName) &&
    Object.keys(value).some((key) => key === 'rolename' || key === 'role')
  )
    return true;
  return Object.values(value).some((entry) => hasNamedRole(entry, roleName));
}

function findFunctionDefinition(
  statements: readonly ParsedStatement[],
  qualifiedName: string,
): NodeVariant | undefined {
  return (
    statements
      .map((entry) => nodeVariant(entry.stmt))
      .find(
        (entry) =>
          entry?.tag === 'CreateFunctionStmt' && getDefinitionName(entry.payload) === qualifiedName,
      ) ?? undefined
  );
}

function roleAttributesAreLeastPrivilege(
  nodeType: 'CreateRoleStmt' | 'AlterRoleStmt',
  payload: JsonObject,
): string | null {
  const safeFalseAttributes = new Set([
    'canlogin',
    'superuser',
    'createdb',
    'createrole',
    'replication',
    'bypassrls',
    'inherit',
  ]);
  const options = nodeArray(payload.options);
  let explicitlyNoLogin = false;

  for (const option of options) {
    const definition = nodeVariant(option);
    if (definition?.tag !== 'DefElem' || typeof definition.payload.defname !== 'string') {
      return 'Role options must be recognized PostgreSQL boolean attributes.';
    }
    const attribute = definition.payload.defname;
    const enabled = booleanValue(definition.payload.arg);
    if (!safeFalseAttributes.has(attribute) || enabled !== false) {
      return `Role attribute ${attribute} may not be enabled or changed by an extension migration.`;
    }
    if (attribute === 'canlogin') explicitlyNoLogin = true;
  }

  if (!explicitlyNoLogin) return `${nodeType} must explicitly set NOLOGIN.`;
  return null;
}

function analyzeStatement(
  statementNode: NodeVariant,
  extensionSchema: string,
  statements: readonly ParsedStatement[],
  options: ExtensionMigrationLintOptions,
): MigrationLintIssue | null {
  const payload = statementNode.payload;
  const registeredGroupRoles =
    options.registeredGroupRoles ?? new Map<string, ReadonlySet<string>>();

  if (statementNode.tag === 'DoStmt' || statementNode.tag === 'CallStmt') {
    return {
      code: 'unsupported-procedural-statement',
      message: `${statementNode.tag} is not analyzed by the static guard and is rejected.`,
      statement: 0,
    };
  }
  if (statementNode.tag === 'AlterDefaultPrivilegesStmt') {
    return {
      code: 'alter-default-privileges',
      message: 'ALTER DEFAULT PRIVILEGES is forbidden in extension migrations.',
      statement: 0,
    };
  }
  if (statementNode.tag === 'GrantRoleStmt') {
    const message = checkRoleGrant(payload, extensionSchema, registeredGroupRoles);
    return message === null ? null : { code: 'core-role-grant', message, statement: 0 };
  }
  if (statementNode.tag === 'GrantStmt') {
    const objectType = objectTypeFor(statementNode.tag, payload);
    const targetType = payload.targtype;
    const targetInSchema = targetType === 'ACL_TARGET_ALL_IN_SCHEMA';
    const protectedTarget = nodeArray(payload.objects).some((object) => {
      const parts = stringsFromName(object);
      if (targetInSchema || objectType === 'OBJECT_SCHEMA')
        return isProtectedSchema(parts[0] ?? null);
      return isProtectedSchema(schemaForQualifiedName(parts, objectType));
    });
    if (protectedTarget)
      return {
        code: 'core-grant',
        message: 'GRANT or REVOKE targets a protected core schema object.',
        statement: 0,
      };
    const parts = nodeArray(payload.objects).flatMap((object) => stringsFromName(object));
    if (parts.some((part) => protectedSchemas.has(part)))
      return {
        code: 'core-grant',
        message: 'GRANT or REVOKE targets a protected core schema.',
        statement: 0,
      };
    return null;
  }
  if (statementNode.tag === 'InsertStmt') {
    if (!targetIsProtected(payload.relation)) return null;
    const schema = relationSchema(payload.relation);
    const table = isRecord(payload.relation) ? payload.relation.relname : null;
    if (
      schema === 'app_config' &&
      table === 'operator_alert_exempt_keys' &&
      payload.onConflictClause === undefined
    )
      return null;
    return {
      code: 'core-data-mutation',
      message:
        'INSERT targets a protected core table outside the declared extensible table exception.',
      statement: 0,
    };
  }
  if (
    ['UpdateStmt', 'DeleteStmt', 'MergeStmt', 'TruncateStmt', 'CopyStmt'].includes(
      statementNode.tag,
    )
  ) {
    const targets =
      statementNode.tag === 'TruncateStmt' ? nodeArray(payload.relations) : [payload.relation];
    if (targets.some((target) => targetIsProtected(target))) {
      return {
        code: 'core-data-mutation',
        message: `${statementNode.tag} targets a protected core table.`,
        statement: 0,
      };
    }
    return null;
  }
  if (statementNode.tag === 'AlterOwnerStmt') {
    const targetOwner = isRecord(payload.newowner) ? payload.newowner.rolename : undefined;
    const object = nodeVariant(payload.object);
    const parts = object?.tag === 'ObjectWithArgs' ? stringsFromName(object.payload.objname) : [];
    const schema = schemaForQualifiedName(parts, payload.objectType);
    if (isProtectedSchema(schema))
      return {
        code: 'core-owner-change',
        message:
          'Object ownership in a protected core schema cannot change in extension migrations.',
        statement: 0,
      };
    if (payload.objectType === 'OBJECT_FUNCTION') {
      const qualifiedName = parts.join('.');
      const definition = findFunctionDefinition(statements, qualifiedName);
      const options = definition === undefined ? null : functionOptions(definition.payload);
      if (
        schema === extensionSchema &&
        targetOwner === `${extensionSchema}_system` &&
        options?.securityDefiner === true &&
        options.emptySearchPath
      ) {
        return null;
      }
      return {
        code: 'extension-function-owner',
        message:
          'Own-schema SECURITY DEFINER functions must use the extension system role; core ownership transfers are not permitted in extension migrations.',
        statement: 0,
      };
    }
    if (payload.objectType === 'OBJECT_PROCEDURE') {
      return {
        code: 'extension-function-owner',
        message: 'Procedure ownership transfers are not supported by the static exception.',
        statement: 0,
      };
    }
    if (
      schema !== extensionSchema ||
      typeof targetOwner !== 'string' ||
      !targetOwner.startsWith(`${extensionSchema}_`)
    ) {
      return {
        code: 'extension-owner-change',
        message: `Ownership changes must stay in ${extensionSchema} and use a ${extensionSchema}_ role.`,
        statement: 0,
      };
    }
    return null;
  }
  if (statementNode.tag === 'CreateExtensionStmt') {
    let targetSchema: string | null = null;
    for (const option of nodeArray(payload.options)) {
      const elem = nodeVariant(option);
      if (elem?.tag === 'DefElem' && elem.payload.defname === 'schema')
        targetSchema = stringValue(elem.payload.arg);
    }
    if (isProtectedSchema(targetSchema ?? 'public'))
      return {
        code: 'core-extension',
        message: 'CREATE EXTENSION must explicitly use an extension-owned schema.',
        statement: 0,
      };
    if (targetSchema !== extensionSchema)
      return {
        code: 'extension-schema',
        message: `CREATE EXTENSION must target schema ${extensionSchema}.`,
        statement: 0,
      };
    return null;
  }
  if (
    statementNode.tag === 'CreateRoleStmt' ||
    statementNode.tag === 'AlterRoleStmt' ||
    statementNode.tag === 'DropRoleStmt'
  ) {
    const candidates =
      statementNode.tag === 'CreateRoleStmt'
        ? [payload.role]
        : statementNode.tag === 'AlterRoleStmt'
          ? [stringsFromName(payload.role)[0]]
          : nodeArray(payload.roles).map((role) => stringsFromName(role)[0]);
    if (
      candidates.some((role) => typeof role !== 'string' || !role.startsWith(`${extensionSchema}_`))
    ) {
      return {
        code: 'core-role-ddl',
        message: `Role DDL is limited to roles prefixed ${extensionSchema}_.`,
        statement: 0,
      };
    }
    if (statementNode.tag === 'CreateRoleStmt' || statementNode.tag === 'AlterRoleStmt') {
      const violation = roleAttributesAreLeastPrivilege(statementNode.tag, payload);
      if (violation !== null) return { code: 'role-privilege', message: violation, statement: 0 };
    }
    return null;
  }

  const schema = extensionLocalDdlSchema(statementNode.tag, payload);
  const ddlTags = new Set([
    'CreateStmt',
    'CreateSeqStmt',
    'AlterSeqStmt',
    'IndexStmt',
    'CreateTrigStmt',
    'CreatePolicyStmt',
    'AlterPolicyStmt',
    'AlterTableStmt',
    'CreateFunctionStmt',
    'CreateSchemaStmt',
    'CreateForeignTableStmt',
    'ViewStmt',
    'CreateViewStmt',
    'CreateTableAsStmt',
    'CreateDomainStmt',
    'DefineStmt',
    'CreateOpClassStmt',
    'CreateOpFamilyStmt',
  ]);
  if (ddlTags.has(statementNode.tag)) {
    if (schema === null)
      return {
        code: 'unsupported-ddl-target',
        message: `${statementNode.tag} target could not be established from the PostgreSQL AST.`,
        statement: 0,
      };
    if (isProtectedSchema(schema))
      return {
        code: 'core-ddl',
        message: `${statementNode.tag} targets protected schema ${schema}.`,
        statement: 0,
      };
    if (schema !== extensionSchema)
      return {
        code: 'extension-schema',
        message: `${statementNode.tag} must target extension schema ${extensionSchema}.`,
        statement: 0,
      };
    if (statementNode.tag === 'CreateStmt' && createTableHasForbiddenCoreForeignKey(payload)) {
      return {
        code: 'foreign-key-target',
        message:
          "The only protected-schema foreign key allowed is the extension table's 1:1 reference to auth.users(id).",
        statement: 0,
      };
    }
    if (
      statementNode.tag === 'AlterTableStmt' &&
      alterTableHasForbiddenCoreForeignKey(payload, options.knownPrimaryKeyColumns ?? new Map())
    ) {
      return {
        code: 'foreign-key-target',
        message:
          'ALTER TABLE may reference only auth.users(id) with a single extension-owned key column.',
        statement: 0,
      };
    }
    if (['CreateFunctionStmt'].includes(statementNode.tag)) {
      const functionOpts = functionOptions(payload);
      if (functionOpts.securityDefiner) {
        const name = getDefinitionName(payload) ?? '';
        const signature = getFunctionSignature(payload);
        if (!functionOpts.emptySearchPath)
          return {
            code: 'function-search-path',
            message: `SECURITY DEFINER function ${name}${signature} must set search_path to an empty value.`,
            statement: 0,
          };
        const requiredOwner = `${extensionSchema}_system`;
        if (!hasFunctionOwnerTransfer(statements, name, signature, requiredOwner)) {
          return {
            code: 'function-owner-transfer',
            message: `SECURITY DEFINER function ${name}${signature} must transfer ownership to ${requiredOwner} in this migration.`,
            statement: 0,
          };
        }
      }
    }
    return null;
  }

  if (['CommentStmt', 'SecLabelStmt', 'DropStmt'].includes(statementNode.tag)) {
    const objectType = objectTypeFor(statementNode.tag, payload);
    const targets =
      statementNode.tag === 'DropStmt' ? nodeArray(payload.objects) : [payload.object];
    const targetSchemas = targets.map((target) =>
      schemaForQualifiedName(stringsFromName(target), objectType),
    );
    if (targetSchemas.some((target) => target === null))
      return {
        code: 'unsupported-object-target',
        message: `${statementNode.tag} target could not be established from the PostgreSQL AST.`,
        statement: 0,
      };
    if (targetSchemas.some(isProtectedSchema))
      return {
        code: 'core-ddl',
        message: `${statementNode.tag} targets a protected core object.`,
        statement: 0,
      };
    if (targetSchemas.some((target) => target !== extensionSchema))
      return {
        code: 'extension-schema',
        message: `${statementNode.tag} must target extension schema ${extensionSchema}.`,
        statement: 0,
      };
    return null;
  }

  if (
    statementNode.tag === 'AlterDefaultPrivilegesStmt' ||
    statementNode.tag === 'CreateEventTrigStmt' ||
    statementNode.tag === 'AlterEventTrigStmt' ||
    statementNode.tag === 'VariableSetStmt'
  ) {
    return {
      code: 'unsupported-global-ddl',
      message: `${statementNode.tag} is not permitted in extension migrations.`,
      statement: 0,
    };
  }
  return {
    code: 'unsupported-statement',
    message: `Unsupported PostgreSQL statement ${statementNode.tag}; refusing to assume its target is safe.`,
    statement: 0,
  };
}

export async function lintExtensionMigration(
  migration: ExtensionMigration,
  options: ExtensionMigrationLintOptions = {},
): Promise<ExtensionMigrationLintResult> {
  const extensionSchema = extensionSchemaFromFilename(migration.name);
  const knownPrimaryKeyColumns = new Map(options.knownPrimaryKeyColumns ?? []);
  if (extensionSchema === null) {
    if (isMalformedExtensionMigrationName(migration.name)) {
      return {
        isExtensionMigration: true,
        extensionSchema: null,
        knownPrimaryKeyColumns,
        issues: [
          {
            code: 'migration-filename',
            message:
              'Extension migration name must follow <timestamp>_ext-<extension>_<subject>.sql.',
            statement: 0,
          },
        ],
      };
    }
    return {
      isExtensionMigration: false,
      extensionSchema: null,
      issues: [],
      knownPrimaryKeyColumns,
    };
  }
  if (migration.contents.trim().length === 0)
    return { isExtensionMigration: true, extensionSchema, issues: [], knownPrimaryKeyColumns };

  let parseResult: ParsedSql;
  try {
    const parsed: unknown = await parsePostgresSql(migration.contents);
    if (!isRecord(parsed)) throw new MigrationLintError('Parser returned an invalid parse result.');
    parseResult = parsed as ParsedSql;
  } catch {
    return {
      isExtensionMigration: true,
      extensionSchema,
      knownPrimaryKeyColumns,
      issues: [
        {
          code: 'sql-parse',
          message:
            'PostgreSQL parser rejected this migration; source text is omitted from diagnostics.',
          statement: 0,
        },
      ],
    };
  }

  if (typeof parseResult.version !== 'number' || Math.floor(parseResult.version / 10000) !== 17) {
    return {
      isExtensionMigration: true,
      extensionSchema,
      knownPrimaryKeyColumns,
      issues: [
        {
          code: 'parser-version',
          message: 'Migration parser is not using PostgreSQL 17 grammar.',
          statement: 0,
        },
      ],
    };
  }
  const statements = parseResult.stmts ?? [];
  const issues: MigrationLintIssue[] = [];
  statements.forEach((rawStatement, index) => {
    const node = nodeVariant(rawStatement.stmt);
    if (node === null) {
      addIssue(
        issues,
        'unknown-ast',
        'PostgreSQL parser returned an unsupported statement node.',
        index + 1,
      );
      return;
    }
    const issue = analyzeStatement(node, extensionSchema, statements, {
      ...options,
      knownPrimaryKeyColumns,
    });
    if (issue !== null) addIssue(issues, issue.code, issue.message, index + 1);
    if (issue === null) updatePrimaryKeyMetadata(node, extensionSchema, knownPrimaryKeyColumns);
  });
  return { isExtensionMigration: true, extensionSchema, issues, knownPrimaryKeyColumns };
}

export interface MigrationLintCommandResult {
  readonly checked: number;
  readonly coreChecked: number;
  readonly skipped: number;
  readonly issues: readonly { migration: string; issue: MigrationLintIssue }[];
}

export interface MigrationNameCheckOptions {
  readonly derived?: boolean;
  readonly upstreamMigrationNames?: ReadonlySet<string>;
  readonly changedMigrationNames?: ReadonlySet<string>;
}

function gitOutput(projectRoot: string, args: readonly string[]): string {
  try {
    return execFileSync('git', [...args], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new MigrationLintError(
      'Derived repository migration checks require an accessible upstream/main ref; fetch upstream/main before running this gate.',
    );
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function loadGitMigrationNames(projectRoot: string): {
  upstream: Set<string>;
  changed: Set<string>;
} {
  gitOutput(projectRoot, ['rev-parse', '--verify', 'upstream/main']);
  const upstreamOutput = gitOutput(projectRoot, [
    'ls-tree',
    '-r',
    '--name-only',
    'upstream/main',
    '--',
    'supabase/migrations',
  ]);
  const changedOutput = gitOutput(projectRoot, [
    'diff',
    '--name-only',
    'upstream/main',
    '--',
    'supabase/migrations/',
  ]);
  const untrackedOutput = gitOutput(projectRoot, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '--',
    'supabase/migrations/',
  ]);
  const upstream = new Set(
    upstreamOutput
      .split(/\r?\n/)
      .filter(Boolean)
      .map((name) => path.basename(name)),
  );
  const changed = new Set(
    [
      ...changedOutput.split(/\r?\n/).filter(Boolean),
      ...untrackedOutput.split(/\r?\n/).filter(Boolean),
    ].map((name) => path.basename(name)),
  );
  return { upstream, changed };
}

function gitCommandSucceeds(projectRoot: string, args: readonly string[]): boolean {
  try {
    execFileSync('git', [...args], { cwd: projectRoot, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function upstreamRepositorySignals(
  projectRoot: string,
): Pick<DerivedRepositorySignals, 'upstreamRemotePresent' | 'upstreamMainRefPresent'> {
  const remoteNames = gitOutput(projectRoot, ['remote']).split(/\r?\n/).filter(Boolean);
  return {
    upstreamRemotePresent: remoteNames.includes('upstream'),
    upstreamMainRefPresent: gitCommandSucceeds(projectRoot, [
      'rev-parse',
      '--verify',
      'refs/remotes/upstream/main',
    ]),
  };
}

export interface RegistryDocument {
  readonly filename: string;
  readonly extensionSchema: string;
  readonly document: unknown;
}

export function parseCoreAuthFunctionRegistry(document: unknown): CoreAuthFunctionRegistration[] {
  try {
    return parseCoreAuthFunctionRegistryDocument(document);
  } catch (error) {
    throw new MigrationLintError(
      error instanceof Error ? error.message : 'Invalid core Auth-function registry.',
    );
  }
}

async function loadCoreAuthFunctionRegistry(
  projectRoot: string,
): Promise<CoreAuthFunctionRegistration[]> {
  const filePath = path.join(projectRoot, 'supabase', 'tests', 'core-auth-fn-registry.json');
  let source: string;
  try {
    const fileStat = await lstat(filePath);
    if (!fileStat.isFile())
      throw new MigrationLintError('Core Auth-function registry must be a regular file.');
    source = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error instanceof MigrationLintError) throw error;
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      throw new MigrationLintError('Missing supabase/tests/core-auth-fn-registry.json.');
    throw error;
  }
  try {
    return parseCoreAuthFunctionRegistry(JSON.parse(source) as unknown);
  } catch (error) {
    if (error instanceof MigrationLintError) throw error;
    throw new MigrationLintError('Invalid JSON in supabase/tests/core-auth-fn-registry.json.');
  }
}

export async function lintCoreAuthFunctionMigrations(
  migrations: readonly ExtensionMigration[],
  registrations: readonly CoreAuthFunctionRegistration[],
): Promise<CoreAuthFunctionLintIssue[]> {
  const registered = new Map(
    registrations.map((entry) => [
      coreAuthFunctionIdentity(entry.schema, entry.name, entry.signature),
      entry,
    ]),
  );
  const definitions = new Map<string, number>();
  const issues: CoreAuthFunctionLintIssue[] = [];
  const report = (migration: string, code: string, message: string, statement: number): void => {
    issues.push({ migration, code, message, statement });
  };

  for (const migration of migrations) {
    if (
      extensionSchemaFromFilename(migration.name) !== null ||
      isMalformedExtensionMigrationName(migration.name)
    )
      continue;
    if (migration.contents.trim().length === 0) continue;
    let parseResult: ParsedSql;
    try {
      const parsed: unknown = await parsePostgresSql(migration.contents);
      if (!isRecord(parsed))
        throw new MigrationLintError('Parser returned an invalid parse result.');
      parseResult = parsed as ParsedSql;
    } catch {
      report(
        migration.name,
        'sql-parse',
        'PostgreSQL parser rejected this migration; source text is omitted from diagnostics.',
        0,
      );
      continue;
    }
    if (typeof parseResult.version !== 'number' || Math.floor(parseResult.version / 10000) !== 17) {
      report(
        migration.name,
        'parser-version',
        'Migration parser is not using PostgreSQL 17 grammar.',
        0,
      );
      continue;
    }

    const statements = parseResult.stmts ?? [];
    statements.forEach((rawStatement, index) => {
      const node = nodeVariant(rawStatement.stmt);
      if (node === null) return;
      const statementNumber = index + 1;
      if (hasNamedRole(node.payload, 'auth_fn_owner')) {
        report(
          migration.name,
          'legacy-auth-owner',
          'The removed auth_fn_owner role cannot be created, granted, or assigned in core migrations.',
          statementNumber,
        );
      }
      const ownerChange = functionOwnerTransfer(rawStatement);
      if (ownerChange?.owner === 'postgres') {
        const identity = coreAuthFunctionIdentity(
          ownerChange.name.split('.')[0] ?? '',
          ownerChange.name.split('.')[1] ?? '',
          ownerChange.signature,
        );
        const registration = registered.get(identity);
        if (registration === undefined) {
          report(
            migration.name,
            'unregistered-postgres-function-owner',
            'Only fixed core Auth functions may transfer function ownership to postgres.',
            statementNumber,
          );
        } else if (
          registration.migration !== migration.name ||
          registration.owner !== ownerChange.owner
        ) {
          report(
            migration.name,
            'core-auth-function-migration',
            `Core Auth function ${identity} must use its registered core migration and owner.`,
            statementNumber,
          );
        }
      }

      if (node.tag !== 'CreateFunctionStmt') return;
      const qualifiedName = getDefinitionName(node.payload);
      if (qualifiedName === null) return;
      const nameParts = qualifiedName.split('.');
      if (nameParts.length === 1) nameParts.unshift('public');
      if (nameParts.length !== 2) return;
      const signature = getFunctionSignature(node.payload);
      const identity = coreAuthFunctionIdentity(nameParts[0] ?? '', nameParts[1] ?? '', signature);
      const registration = registered.get(identity);
      const options = functionOptions(node.payload);
      const transfer = statements
        .map((entry) => functionOwnerTransfer(entry))
        .find((entry) => entry?.name === qualifiedName && entry.signature === signature);

      if (registration !== undefined) {
        definitions.set(identity, (definitions.get(identity) ?? 0) + 1);
        if (registration.migration !== migration.name) {
          report(
            migration.name,
            'core-auth-function-migration',
            `Core Auth function ${identity} must be defined in ${registration.migration}.`,
            statementNumber,
          );
        }
        if (!options.securityDefiner) {
          report(
            migration.name,
            'core-auth-function-definition',
            `Core Auth function ${identity} must be SECURITY DEFINER.`,
            statementNumber,
          );
        } else if (!options.emptySearchPath) {
          report(
            migration.name,
            'function-search-path',
            `SECURITY DEFINER function ${identity} must set search_path to an empty value.`,
            statementNumber,
          );
        }
        // Core migrations run through the approved postgres connection. A newly
        // created registered function is therefore postgres-owned unless this
        // migration explicitly changes ownership.
        if (transfer !== undefined && transfer !== null && transfer.owner !== registration.owner) {
          report(
            migration.name,
            'core-auth-function-owner',
            `Core Auth function ${identity} must transfer ownership to ${registration.owner} in the same migration.`,
            statementNumber,
          );
        }
      } else if (
        options.securityDefiner &&
        (transfer === undefined || transfer === null || transfer.owner === 'postgres')
      ) {
        report(
          migration.name,
          'unregistered-postgres-function-owner',
          'Every non-Auth SECURITY DEFINER function must transfer ownership away from the migration role.',
          statementNumber,
        );
      }
    });
  }

  for (const registration of registrations) {
    const identity = coreAuthFunctionIdentity(
      registration.schema,
      registration.name,
      registration.signature,
    );
    if ((definitions.get(identity) ?? 0) === 0) {
      report(
        registration.migration,
        'core-auth-function-definition',
        `Registered core Auth function ${identity} has no migration definition.`,
        0,
      );
    } else if ((definitions.get(identity) ?? 0) > 1) {
      report(
        registration.migration,
        'core-auth-function-definition',
        `Registered core Auth function ${identity} has multiple migration definitions.`,
        0,
      );
    }
  }
  return issues;
}

function registryExtensionSchema(filename: string): string {
  const match = filename.match(/^([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)\.json$/);
  if (match?.[1] === undefined)
    throw new MigrationLintError(`Invalid extension registry filename: ${filename}.`);
  return match[1].replaceAll('-', '_');
}

async function loadJsonFiles(directory: string): Promise<RegistryDocument[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .sort((left, right) => (left.name < right.name ? -1 : 1));
  const documents: RegistryDocument[] = [];
  for (const entry of files) {
    const filePath = path.join(directory, entry.name);
    const source = await readFile(filePath, 'utf8');
    try {
      documents.push({
        filename: path.relative(process.cwd(), filePath),
        extensionSchema: registryExtensionSchema(entry.name),
        document: JSON.parse(source) as unknown,
      });
    } catch {
      throw new MigrationLintError(
        `Invalid JSON registry: ${path.relative(process.cwd(), filePath)}.`,
      );
    }
  }
  return documents;
}

export function parseExpectedGroupMemberDocuments(
  documents: readonly RegistryDocument[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const members = new Map<string, Set<string>>(
    [...allowedCoreGroupRoles].map((role) => [role, new Set<string>()]),
  );
  for (const source of documents) {
    const parsed = expectedGroupMembersSchema.safeParse(source.document);
    if (!parsed.success)
      throw new MigrationLintError(
        `Invalid expected group-members registry shape: ${source.filename}.`,
      );
    for (const group of allowedCoreGroupRoles) {
      const roles = parsed.data[group as keyof typeof parsed.data] ?? [];
      for (const role of roles) {
        if (!role.startsWith(`${source.extensionSchema}_`)) {
          throw new MigrationLintError(
            `Expected group member ${role} in ${source.filename} must start with ${source.extensionSchema}_.`,
          );
        }
        members.get(group)?.add(role);
      }
    }
  }
  return members;
}

export async function lintExtensionMigrations(
  projectRoot = process.cwd(),
  nameCheckOptions: MigrationNameCheckOptions = {},
): Promise<MigrationLintCommandResult> {
  const supabaseDirectory = path.join(projectRoot, 'supabase');
  const migrationsDirectory = path.join(supabaseDirectory, 'migrations');
  let entries: Dirent<string>[];
  try {
    entries = await readdir(migrationsDirectory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') entries = [];
    else throw error;
  }

  const migrations = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .sort((left, right) => (left.name < right.name ? -1 : 1));
  const declaredByBootstrap = await fileExists(path.join(projectRoot, 'AGENTS.bootstrap.md'));
  const upstreamSignals = upstreamRepositorySignals(projectRoot);
  const detectedDerived = resolveDerivedRepositoryMode({
    bootstrapFilePresent: declaredByBootstrap,
    ...upstreamSignals,
  });
  const declaredDerived = nameCheckOptions.derived ?? detectedDerived;
  if (declaredDerived) {
    const gitNames =
      nameCheckOptions.upstreamMigrationNames === undefined
        ? loadGitMigrationNames(projectRoot)
        : {
            upstream: new Set(nameCheckOptions.upstreamMigrationNames),
            changed: nameCheckOptions.changedMigrationNames ?? new Set<string>(),
          };
    const nameProblems = validateDerivedMigrationNames({
      declaredDerived: true,
      localMigrationNames: migrations.map((entry) => entry.name),
      upstreamMigrationNames: gitNames.upstream,
      changedMigrationNames: gitNames.changed,
    });
    if (nameProblems.length > 0) throw new MigrationLintError(nameProblems.join('\n'));
  }
  if (await fileExists(path.join(supabaseDirectory, 'tests', 'auth-fn-registry.d')))
    throw new MigrationLintError(
      'supabase/tests/auth-fn-registry.d is no longer supported; use the fixed core Auth-function registry.',
    );
  const registrations = await loadCoreAuthFunctionRegistry(projectRoot);
  const groupRoles = parseExpectedGroupMemberDocuments(
    await loadJsonFiles(path.join(supabaseDirectory, 'tests', 'expected-group-members.d')),
  );
  const migrationSources = await Promise.all(
    migrations.map(async (entry) => ({
      name: entry.name,
      contents: await readFile(path.join(migrationsDirectory, entry.name), 'utf8'),
    })),
  );
  const coreAuthIssues = await lintCoreAuthFunctionMigrations(migrationSources, registrations);
  const issues: { migration: string; issue: MigrationLintIssue }[] = coreAuthIssues.map(
    ({ migration, code, message, statement }) => ({
      migration,
      issue: { code, message, statement },
    }),
  );
  let checked = 0;
  let coreChecked = 0;
  let skipped = 0;
  let knownPrimaryKeyColumns: ReadonlyMap<string, ReadonlySet<string>> = new Map();

  for (const [index, entry] of migrations.entries()) {
    const result = await lintExtensionMigration(migrationSources[index] as ExtensionMigration, {
      registeredGroupRoles: groupRoles,
      knownPrimaryKeyColumns,
    });
    knownPrimaryKeyColumns = result.knownPrimaryKeyColumns;
    if (!result.isExtensionMigration) {
      skipped += 1;
      coreChecked += 1;
      continue;
    }
    checked += 1;
    for (const issue of result.issues) issues.push({ migration: entry.name, issue });
  }

  return { checked, coreChecked, skipped, issues };
}

export async function runMigrationLintCli(projectRoot = process.cwd()): Promise<void> {
  const result = await lintExtensionMigrations(projectRoot);
  if (result.issues.length > 0) {
    for (const entry of result.issues) {
      process.stderr.write(
        `${entry.migration}: statement ${entry.issue.statement}: ${entry.issue.code}: ${entry.issue.message}\n`,
      );
    }
    throw new MigrationLintError(`${result.issues.length} migration policy violation(s).`);
  }
  process.stdout.write(
    `Checked ${result.checked} extension migration(s) and core Auth ownership in ${result.coreChecked} core migration(s).\n`,
  );
}
