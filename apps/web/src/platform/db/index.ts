import type { DatabaseEnvironment } from '../env/index';
import type { ExtensionSystemRole } from '../kernel/extension-system-role';
import type { AppLogger } from '../observability/logger';
import { createDatabaseRuntime, type DatabaseRuntime } from './runtime';

export type { DbClaims } from './claims';
export type { CoreSystemContext, DbTransaction, SystemDatabaseContext } from './runtime';

export function createDatabase(
  environment: DatabaseEnvironment,
  options: {
    readonly extensionSystemRoles: readonly ExtensionSystemRole[];
    readonly logger: AppLogger;
  },
): DatabaseRuntime {
  return createDatabaseRuntime(environment, options);
}
