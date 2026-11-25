declare const extensionSystemRoleBrand: unique symbol;

export type ExtensionSystemRole = string & {
  readonly [extensionSystemRoleBrand]: 'extension-system-role';
};
