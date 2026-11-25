import type { createDatabase } from '../../../platform/db';
import type { LegalVersions } from '../domain/legal-versions';
import { parseLegalVersions } from '../domain/legal-versions';

type CoreDatabase = ReturnType<typeof createDatabase>;

export interface LegalVersionsReader {
  readCurrent(): Promise<LegalVersions>;
}

export function createLegalVersionsReader(
  database: Pick<CoreDatabase, 'systemDb'>,
): LegalVersionsReader {
  return Object.freeze({
    async readCurrent() {
      return database.systemDb('app-config', async (transaction) => {
        const row = await transaction
          .selectFrom('app_config.settings')
          .select('value')
          .where('key', '=', 'legal')
          .executeTakeFirst();
        if (!row) throw new Error('Current legal versions are unavailable.');
        return parseLegalVersions(row.value);
      });
    },
  });
}
