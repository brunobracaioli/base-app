import * as z from 'zod';
import { sql } from 'kysely';

import type { DbClaims } from '../../../platform/db';
import type { createDatabase } from '../../../platform/db';
import type { AppLogger } from '../../../platform/observability/logger';

type CoreDatabase = ReturnType<typeof createDatabase>;
type VerifiedRoleContext = {
  readonly userId: string;
  readonly dbClaims: DbClaims;
};

const ROLE_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const rolesSchema = z.array(z.string().regex(ROLE_PATTERN)).max(10);

function normalizeRoles(value: unknown, logger: AppLogger): readonly string[] {
  if (value === undefined || value === null) return [];
  const result = rolesSchema.safeParse(value);
  if (!result.success) {
    logger.warn('Fresh Auth roles were discarded.', { reason: 'invalid_list' });
    return [];
  }
  return result.data;
}

export function createFreshRolesReader(
  database: Pick<CoreDatabase, 'userScopedDb'>,
  logger: AppLogger,
): (auth: VerifiedRoleContext) => Promise<readonly string[]> {
  return async (auth) => {
    if (auth.userId !== auth.dbClaims.sub) {
      throw new TypeError('Verified user does not match database claims.');
    }

    const result = await database.userScopedDb(auth.dbClaims, (transaction) =>
      sql<{
        readonly roles: unknown;
      }>`select roles from identity.read_fresh_roles(${auth.dbClaims.sub}::uuid)`.execute(
        transaction,
      ),
    );
    return normalizeRoles(result.rows[0]?.roles, logger);
  };
}
