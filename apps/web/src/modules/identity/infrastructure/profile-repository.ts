import type { DbClaims } from '../../../platform/db';
import type { createDatabase } from '../../../platform/db';
import { ProfileOwnerMissingError } from '../domain/profile-owner-missing';
import type { NormalizedProfilePatch, UserProfile } from '../domain/user-profile';
import { UserProfile as UserProfileModel } from '../domain/user-profile';
import type { ProfileRepository } from '../domain/profile-ports';

type CoreDatabase = ReturnType<typeof createDatabase>;
type ProfileRow = {
  readonly user_id: string;
  readonly display_name: string | null;
  readonly locale: string;
  readonly created_at: string;
};

function mapProfile(row: ProfileRow, supportedLocales: readonly string[]): UserProfile {
  return UserProfileModel.restore(
    {
      userId: row.user_id,
      displayName: row.display_name,
      locale: row.locale,
      createdAt: new Date(row.created_at),
    },
    supportedLocales,
  );
}

function driverCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function assertScope(userId: string, claims: DbClaims): void {
  if (userId !== claims.sub)
    throw new TypeError('Profile user does not match verified database claims.');
}

export function createProfileRepository(input: {
  readonly database: Pick<CoreDatabase, 'userScopedDb'>;
  readonly dbClaims: DbClaims;
  readonly supportedLocales: readonly string[];
}): ProfileRepository {
  const repository: ProfileRepository = {
    async ensureProfile(profileInput) {
      assertScope(profileInput.userId, input.dbClaims);
      try {
        return await input.database.userScopedDb(input.dbClaims, async (transaction) => {
          await transaction
            .insertInto('identity.profiles')
            .values({ user_id: profileInput.userId, locale: profileInput.initialLocale })
            .onConflict((conflict) => conflict.column('user_id').doNothing())
            .execute();

          const row = await transaction
            .selectFrom('identity.profiles')
            .select(['user_id', 'display_name', 'locale', 'created_at'])
            .where('user_id', '=', profileInput.userId)
            .executeTakeFirst();
          if (!row) throw new ProfileOwnerMissingError();
          return mapProfile(row, input.supportedLocales);
        });
      } catch (error) {
        if (driverCode(error) === '23503') throw new ProfileOwnerMissingError();
        throw error;
      }
    },

    async updateProfile(updateInput) {
      assertScope(updateInput.userId, input.dbClaims);
      const values: { display_name?: string | null; locale?: string } = {};
      if (updateInput.changes.displayName !== undefined) {
        values.display_name = updateInput.changes.displayName;
      }
      if (updateInput.changes.locale !== undefined) values.locale = updateInput.changes.locale;
      if (Object.keys(values).length === 0) throw new TypeError('Profile update has no fields.');

      return input.database.userScopedDb(input.dbClaims, async (transaction) => {
        const row = await transaction
          .updateTable('identity.profiles')
          .set(values)
          .where('user_id', '=', updateInput.userId)
          .returning(['user_id', 'display_name', 'locale', 'created_at'])
          .executeTakeFirst();
        if (!row) throw new ProfileOwnerMissingError();
        return mapProfile(row, input.supportedLocales);
      });
    },
  };
  return Object.freeze(repository);
}

export type { NormalizedProfilePatch };
