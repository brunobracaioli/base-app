import type { DbClaims } from '../../../platform/db';
import type { createDatabase } from '../../../platform/db';
import type { ConsentRepository } from '../domain/consent-ports';
import { ConsentRecord } from '../domain/consent-record';

type CoreDatabase = ReturnType<typeof createDatabase>;
type ConsentDocument = 'terms' | 'privacy';

function assertScope(userId: string, claims: DbClaims): void {
  if (userId !== claims.sub)
    throw new TypeError('Consent user does not match verified database claims.');
}

export function createConsentRepository(input: {
  readonly database: Pick<CoreDatabase, 'userScopedDb'>;
  readonly dbClaims: DbClaims;
}): ConsentRepository {
  const repository: ConsentRepository = {
    async listForUser(userId) {
      assertScope(userId, input.dbClaims);
      return input.database.userScopedDb(input.dbClaims, async (transaction) => {
        const rows = await transaction
          .selectFrom('privacy.consents')
          .select(['user_id', 'document', 'version', 'accepted_at'])
          .where('user_id', '=', userId)
          .execute();

        return rows.map((row) => {
          if (row.document !== 'terms' && row.document !== 'privacy') {
            throw new TypeError('Stored consent document is invalid.');
          }
          return ConsentRecord.restore({
            userId: row.user_id,
            document: row.document as ConsentDocument,
            version: row.version,
            acceptedAt: new Date(row.accepted_at),
          });
        });
      });
    },

    async accept(record) {
      assertScope(record.userId, input.dbClaims);
      await input.database.userScopedDb(input.dbClaims, async (transaction) => {
        await transaction
          .insertInto('privacy.consents')
          .values({
            user_id: record.userId,
            document: record.document,
            version: record.version,
            accepted_at: record.acceptedAt.toISOString(),
          })
          .onConflict((conflict) =>
            conflict.columns(['user_id', 'document', 'version']).doNothing(),
          )
          .execute();
      });
    },
  };
  return Object.freeze(repository);
}
