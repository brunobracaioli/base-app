import * as z from 'zod';

export interface AsyncKeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export class InvalidStoredValueError extends Error {
  constructor() {
    super('The value does not match the storage schema.');
    this.name = 'InvalidStoredValueError';
  }
}

export type ValidatedAsyncStorage<T> = {
  read(): Promise<T | null>;
  write(value: unknown): Promise<void>;
  clear(): Promise<void>;
};

export function createValidatedAsyncStorage<T>(
  key: string,
  schema: z.ZodType<T>,
  storage: AsyncKeyValueStorage,
): ValidatedAsyncStorage<T> {
  const removeCorruptValue = async () => {
    try {
      await storage.removeItem(key);
    } catch {
      // A stale cache remains a miss even if native storage cannot remove it.
    }
  };

  return {
    async read(): Promise<T | null> {
      let raw: string | null;
      try {
        raw = await storage.getItem(key);
      } catch {
        return null;
      }
      if (raw === null) return null;

      let decoded: unknown;
      try {
        decoded = JSON.parse(raw) as unknown;
      } catch {
        await removeCorruptValue();
        return null;
      }

      const parsed = schema.safeParse(decoded);
      if (!parsed.success) {
        await removeCorruptValue();
        return null;
      }
      return parsed.data;
    },
    async write(value: unknown): Promise<void> {
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw new InvalidStoredValueError();
      await storage.setItem(key, JSON.stringify(parsed.data));
    },
    async clear(): Promise<void> {
      try {
        await storage.removeItem(key);
      } catch {
        // Clearing a cache is best-effort and never affects app availability.
      }
    },
  };
}
