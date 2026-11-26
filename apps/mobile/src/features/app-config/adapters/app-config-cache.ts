import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppConfigResponse, type AppConfigResponseValue } from '@base-app/contracts';

import {
  createValidatedAsyncStorage,
  InvalidStoredValueError,
  type AsyncKeyValueStorage,
} from './validated-async-storage';

const cacheKey = '@base-app/app-config:v1';

export type AppConfigCache = {
  read(): Promise<AppConfigResponseValue | null>;
  write(value: unknown): Promise<void>;
  clear(): Promise<void>;
};

export function createAppConfigCache(storage: AsyncKeyValueStorage = AsyncStorage): AppConfigCache {
  let mutationQueue: Promise<void> = Promise.resolve();
  let mutationVersion = 0;
  let readVersion = 0;

  const enqueueMutation = (operation: () => Promise<void>): Promise<void> => {
    const next = mutationQueue.then(operation);
    mutationQueue = next.catch(() => undefined);
    return next;
  };

  const serializedStorage: AsyncKeyValueStorage = {
    async getItem(key: string): Promise<string | null> {
      await mutationQueue;
      const versionAtRead = mutationVersion;
      const value = await storage.getItem(key);
      readVersion = versionAtRead;
      return value;
    },
    setItem(key: string, value: string): Promise<void> {
      mutationVersion += 1;
      return enqueueMutation(() => storage.setItem(key, value));
    },
    removeItem(key: string): Promise<void> {
      const versionAtRead = readVersion;
      return enqueueMutation(async () => {
        if (mutationVersion === versionAtRead) await storage.removeItem(key);
      });
    },
  };

  const validatedStorage = createValidatedAsyncStorage(
    cacheKey,
    AppConfigResponse,
    serializedStorage,
  );

  return {
    read: () => validatedStorage.read(),
    async write(value: unknown): Promise<void> {
      try {
        await validatedStorage.write(value);
      } catch (error) {
        if (error instanceof InvalidStoredValueError) throw error;
        // A remote response remains usable for this session if the cache is unavailable.
      }
    },
    clear: () => validatedStorage.clear(),
  };
}

export const appConfigCache = createAppConfigCache();
