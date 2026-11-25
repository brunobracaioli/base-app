import { parseServerEnv, requireDatabaseEnvironment, SERVER_ENV_SCHEMA } from '../env/index';
import type { DatabaseEnvironment, ServerEnv } from '../env/index';
import { createLogger } from '../observability/logger';
import type { AppLogger } from '../observability/logger';
import { serverExtensions } from '../../extensions';
import { composeServerExtensions } from '../extensions/composition';
import type { ExtensionComposition, ExtensionSystemRole } from '../extensions/types';

export const serverExtensionComposition = composeServerExtensions(serverExtensions, {
  coreEnvironmentKeys: Object.keys(SERVER_ENV_SCHEMA.shape),
  environment: process.env,
});

export type DatabaseFactoryOptions = {
  readonly extensionSystemRoles: readonly ExtensionSystemRole[];
  readonly logger: AppLogger;
};

export function composePlatformRuntime<Database>(input: {
  readonly createDatabase: (
    environment: DatabaseEnvironment,
    options: DatabaseFactoryOptions,
  ) => Database;
  readonly environment?: ServerEnv;
  readonly extensionComposition?: ExtensionComposition;
  readonly logger?: AppLogger;
}): {
  readonly extensions: ExtensionComposition;
  readonly database: Database;
} {
  const environment = requireDatabaseEnvironment(input.environment ?? parseServerEnv());
  const extensions = input.extensionComposition ?? serverExtensionComposition;
  return {
    extensions,
    database: input.createDatabase(environment, {
      extensionSystemRoles: extensions.extensionSystemRoles,
      logger: input.logger ?? createLogger(),
    }),
  };
}
