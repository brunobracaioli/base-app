import type { DbTransaction } from '../../../platform/db';
import type { AccountPurgeRequested } from '../../../platform/events';
import type { EventHandler } from '../../../platform/extensions/types';

/**
 * Binds this handler to the caller-owned transaction. The caller must run it
 * under privacy_system or safely switch to that role and restore its prior
 * role within this same transaction before any other handler runs.
 */
export function createPrivacyPurgeHandler(
  transaction: DbTransaction,
): EventHandler<AccountPurgeRequested> {
  return async (event) => {
    await transaction.deleteFrom('privacy.consents').where('user_id', '=', event.userId).execute();
  };
}
