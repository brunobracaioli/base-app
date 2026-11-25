export type UserProfileSnapshot = {
  readonly userId: string;
  readonly displayName: string | null;
  readonly locale: string;
  readonly createdAt: Date;
};

export type ProfilePatch = {
  readonly displayName?: string | null;
  readonly locale?: string;
};

export type NormalizedProfilePatch = {
  readonly displayName?: string | null;
  readonly locale?: string;
};

export class InvalidUserProfileError extends Error {
  constructor(readonly field: 'userId' | 'displayName' | 'locale' | 'createdAt') {
    super(`Invalid user profile ${field}.`);
    this.name = 'InvalidUserProfileError';
  }
}

export class InvalidProfileUpdateError extends InvalidUserProfileError {
  constructor(field: 'userId' | 'displayName' | 'locale' | 'createdAt') {
    super(field);
    this.name = 'InvalidProfileUpdateError';
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/gu;

export function normalizeDisplayName(value: string | null): string | null {
  if (value === null) return null;

  const normalized = value
    .trim()
    .normalize('NFC')
    .replace(CONTROL_CHARACTER_PATTERN, '')
    .normalize('NFC');
  if (normalized.length < 1 || normalized.length > 80) {
    throw new InvalidUserProfileError('displayName');
  }
  return normalized;
}

export function resolveInitialLocale(
  hint: string | undefined,
  supportedLocales: readonly string[],
  defaultLocale: string,
): string {
  if (!supportedLocales.includes(defaultLocale)) throw new InvalidUserProfileError('locale');
  return hint !== undefined && supportedLocales.includes(hint) ? hint : defaultLocale;
}

export function normalizeProfilePatch(
  patch: ProfilePatch,
  supportedLocales: readonly string[],
): NormalizedProfilePatch {
  const normalized: { displayName?: string | null; locale?: string } = {};
  if (patch.displayName !== undefined)
    normalized.displayName = normalizeDisplayName(patch.displayName);
  if (patch.locale !== undefined) {
    if (!supportedLocales.includes(patch.locale)) throw new InvalidUserProfileError('locale');
    normalized.locale = patch.locale;
  }
  if (normalized.displayName === undefined && normalized.locale === undefined) {
    throw new InvalidUserProfileError('displayName');
  }
  return normalized;
}

export class UserProfile {
  private constructor(
    readonly userId: string,
    readonly displayName: string | null,
    readonly locale: string,
    readonly createdAt: Date,
    private readonly supportedLocales: readonly string[],
  ) {}

  static restore(input: UserProfileSnapshot, supportedLocales: readonly string[]): UserProfile {
    if (!UUID_PATTERN.test(input.userId)) throw new InvalidUserProfileError('userId');
    if (!supportedLocales.includes(input.locale)) throw new InvalidUserProfileError('locale');
    if (!(input.createdAt instanceof Date) || !Number.isFinite(input.createdAt.getTime())) {
      throw new InvalidUserProfileError('createdAt');
    }
    const displayName = normalizeDisplayName(input.displayName);
    return new UserProfile(
      input.userId,
      displayName,
      input.locale,
      new Date(input.createdAt.getTime()),
      Object.freeze([...supportedLocales]),
    );
  }

  update(patch: ProfilePatch): {
    readonly profile: UserProfile;
    readonly changes: NormalizedProfilePatch;
  } {
    let changes: NormalizedProfilePatch;
    try {
      changes = normalizeProfilePatch(patch, this.supportedLocales);
    } catch (error) {
      if (error instanceof InvalidUserProfileError) {
        throw new InvalidProfileUpdateError(error.field);
      }
      throw error;
    }
    return {
      profile: new UserProfile(
        this.userId,
        changes.displayName === undefined ? this.displayName : changes.displayName,
        changes.locale ?? this.locale,
        new Date(this.createdAt.getTime()),
        this.supportedLocales,
      ),
      changes,
    };
  }
}
