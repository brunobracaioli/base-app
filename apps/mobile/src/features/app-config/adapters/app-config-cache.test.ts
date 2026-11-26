import { createAppConfigCache } from './app-config-cache';
import type { AsyncKeyValueStorage } from './validated-async-storage';

const validConfig = {
  versions: {
    ios: {
      minSupported: '1.0.0',
      latest: '1.1.0',
      storeUrl: 'https://apps.apple.com/app/id0000000000',
    },
    android: {
      minSupported: '1.0.0',
      latest: '1.1.0',
      storeUrl: 'https://play.google.com/store/apps/details?id=com.example.myapp',
    },
  },
  maintenance: {
    active: false,
    platforms: ['ios', 'android'],
    messageKey: 'maintenance.default',
    until: null,
  },
  legal: {
    termsVersion: '2026-01-01',
    privacyVersion: '2026-01-01',
    termsUrl: 'https://myapp.example.invalid/terms',
    privacyUrl: 'https://myapp.example.invalid/privacy',
  },
};

function makeStorage(initial: string | null = null) {
  let value = initial;
  const storage: AsyncKeyValueStorage = {
    getItem: jest.fn(async () => value),
    setItem: jest.fn(async (_key, nextValue) => {
      value = nextValue;
    }),
    removeItem: jest.fn(async () => {
      value = null;
    }),
  };
  return { storage, getValue: () => value };
}

describe('app config cache', () => {
  it('reads a valid response from storage', async () => {
    const { storage } = makeStorage(JSON.stringify(validConfig));
    await expect(createAppConfigCache(storage).read()).resolves.toEqual(validConfig);
  });

  it('removes malformed JSON and schema-invalid cached data', async () => {
    const malformed = makeStorage('{');
    await expect(createAppConfigCache(malformed.storage).read()).resolves.toBeNull();
    expect(malformed.storage.removeItem).toHaveBeenCalledTimes(1);

    const invalid = makeStorage(JSON.stringify({ ...validConfig, extra: 'unexpected' }));
    await expect(createAppConfigCache(invalid.storage).read()).resolves.toBeNull();
    expect(invalid.storage.removeItem).toHaveBeenCalledTimes(1);
  });

  it('does not persist invalid response data', async () => {
    const { storage, getValue } = makeStorage();
    await expect(
      createAppConfigCache(storage).write({ ...validConfig, extra: true }),
    ).rejects.toThrow();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(getValue()).toBeNull();
  });

  it('treats storage failures as cache misses and ignores write failures', async () => {
    const storage: AsyncKeyValueStorage = {
      getItem: jest.fn().mockRejectedValue(new Error('private storage detail')),
      setItem: jest.fn().mockRejectedValue(new Error('private storage detail')),
      removeItem: jest.fn().mockRejectedValue(new Error('private storage detail')),
    };
    const cache = createAppConfigCache(storage);
    await expect(cache.read()).resolves.toBeNull();
    await expect(cache.write(validConfig)).resolves.toBeUndefined();
  });

  it('serializes slow writes so an older response cannot become the persisted cache value', async () => {
    let stored: string | null = null;
    let startFirstWrite!: () => void;
    let finishFirstWrite!: () => void;
    const firstWriteStarted = new Promise<void>((resolve) => {
      startFirstWrite = resolve;
    });
    const firstWriteCompletion = new Promise<void>((resolve) => {
      finishFirstWrite = resolve;
    });
    let calls = 0;
    const storage: AsyncKeyValueStorage = {
      getItem: async () => stored,
      async setItem(_key, value) {
        calls += 1;
        if (calls === 1) {
          startFirstWrite();
          await firstWriteCompletion;
        }
        stored = value;
      },
      removeItem: async () => {
        stored = null;
      },
    };
    const cache = createAppConfigCache(storage);
    const older = { ...validConfig, legal: { ...validConfig.legal, termsVersion: '2026-01-02' } };
    const newer = { ...validConfig, legal: { ...validConfig.legal, termsVersion: '2026-01-03' } };

    const olderWrite = cache.write(older);
    await firstWriteStarted;
    const newerWrite = cache.write(newer);
    expect(calls).toBe(1);

    finishFirstWrite();
    await Promise.all([olderWrite, newerWrite]);
    expect(JSON.parse(stored ?? 'null')).toEqual(newer);
  });

  it('does not let corrupt-cache cleanup erase a newer valid response', async () => {
    let stored: string | null = '{';
    let startRemoval!: () => void;
    let finishRemoval!: () => void;
    const removalStarted = new Promise<void>((resolve) => {
      startRemoval = resolve;
    });
    const removalCompletion = new Promise<void>((resolve) => {
      finishRemoval = resolve;
    });
    const storage: AsyncKeyValueStorage = {
      getItem: async () => stored,
      setItem: async (_key, value) => {
        stored = value;
      },
      async removeItem() {
        startRemoval();
        await removalCompletion;
        stored = null;
      },
    };
    const cache = createAppConfigCache(storage);

    const staleRead = cache.read();
    await removalStarted;
    const validWrite = cache.write(validConfig);
    finishRemoval();
    await Promise.all([staleRead, validWrite]);
    expect(JSON.parse(stored ?? 'null')).toEqual(validConfig);
  });

  it('does not let a deferred corrupt read delete a newer write completed before that read', async () => {
    let stored: string | null = '{';
    let releaseRead!: () => void;
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const readCompletion = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const storage: AsyncKeyValueStorage = {
      async getItem() {
        const staleValue = stored;
        markReadStarted();
        await readCompletion;
        return staleValue;
      },
      async setItem(_key, value) {
        stored = value;
      },
      async removeItem() {
        stored = null;
      },
    };
    const cache = createAppConfigCache(storage);

    const staleRead = cache.read();
    await readStarted;
    await cache.write(validConfig);
    releaseRead();
    await expect(staleRead).resolves.toBeNull();
    expect(JSON.parse(stored ?? 'null')).toEqual(validConfig);
  });
});
