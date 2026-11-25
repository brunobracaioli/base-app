import type { EventHandler } from '../../../platform/extensions/types';
import type { AccountPurgeRequested } from '../../../platform/events';
import type { DbTransaction } from '../../../platform/db';

/**
 * Binds this handler to the caller-owned transaction. The caller must run it
 * under identity_system or safely switch to that role and restore its prior
 * role within this same transaction before any other handler runs.
 */
export function createIdentityPurgeHandler(
  transaction: DbTransaction,
): EventHandler<AccountPurgeRequested> {
  return async (event) => {
    await transaction.deleteFrom('identity.profiles').where('user_id', '=', event.userId).execute();
  };
}
