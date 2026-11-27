import { createEncryptedStorage } from './encrypted-storage';

type AsyncStorageAdapter = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

type SecureStoreAdapter = {
  readonly AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: number;
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(
    key: string,
    value: string,
    options?: { readonly keychainAccessible?: number },
  ): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
};

function createHarness() {
  const values = new Map<string, string>();
  const keys = new Map<string, string>();
  const asyncStorage: AsyncStorageAdapter = {
    getItem: jest.fn(async (key) => values.get(key) ?? null),
    setItem: jest.fn(async (key, value) => {
      values.set(key, value);
    }),
    removeItem: jest.fn(async (key) => {
      values.delete(key);
    }),
  };
  const secureStore: SecureStoreAdapter = {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 17,
    getItemAsync: jest.fn(async (key) => keys.get(key) ?? null),
    setItemAsync: jest.fn(async (key, value) => {
      keys.set(key, value);
    }),
    deleteItemAsync: jest.fn(async (key) => {
      keys.delete(key);
    }),
  };
  let nextByte = 1;
  const randomBytes = jest.fn(async (byteCount: number) =>
    Uint8Array.from({ length: byteCount }, () => {
      const value = nextByte;
      nextByte = (nextByte % 255) + 1;
      return value;
    }),
  );

  return {
    storage: createEncryptedStorage({ asyncStorage, secureStore, randomBytes }),
    asyncStorage,
    secureStore,
    values,
    keys,
    randomBytes,
  };
}

function decodeStoredValue(value: string | undefined): Uint8Array {
  if (value === undefined) throw new Error('Expected stored ciphertext.');
  return new Uint8Array(Buffer.from(value, 'base64'));
}

describe('encrypted Supabase session storage', () => {
  it('encrypts the session with AES-256-GCM and stores its key with device-only accessibility', async () => {
    const harness = createHarness();
    const session = JSON.stringify({ session: 'sample-session' });

    await harness.storage.setItem('sb-project-auth-token', session);

    const ciphertext = harness.values.get('sb-project-auth-token');
    expect(ciphertext).toBeDefined();
    expect(ciphertext).not.toContain(session);
    expect(harness.keys.size).toBe(1);
    expect(harness.secureStore.setItemAsync).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      { keychainAccessible: 17 },
    );
    expect(decodeStoredValue(ciphertext).at(0)).toBe(1);
    expect(await harness.storage.getItem('sb-project-auth-token')).toBe(session);
  });

  it('uses a fresh 12-byte nonce for each write and serializes overlapping writes', async () => {
    const harness = createHarness();
    const key = 'sb-project-auth-token';

    await Promise.all([
      harness.storage.setItem(key, 'first-session'),
      harness.storage.setItem(key, 'second-session'),
    ]);
    await expect(harness.storage.getItem(key)).resolves.toBe('second-session');
    const secondNonce = decodeStoredValue(harness.values.get(key)).slice(1, 13);

    await harness.storage.setItem(key, 'third-session');
    const thirdNonce = decodeStoredValue(harness.values.get(key)).slice(1, 13);

    expect(Buffer.from(secondNonce).equals(Buffer.from(thirdNonce))).toBe(false);
    expect(await harness.storage.getItem(key)).toBe('third-session');
  });

  it('clears the value and key when the ciphertext is tampered with', async () => {
    const harness = createHarness();
    const key = 'sb-project-auth-token';
    await harness.storage.setItem(key, 'sample-session');
    const corrupted = decodeStoredValue(harness.values.get(key));
    corrupted[corrupted.length - 1] = (corrupted.at(-1) ?? 0) ^ 1;
    harness.values.set(key, Buffer.from(corrupted).toString('base64'));

    await expect(harness.storage.getItem(key)).resolves.toBeNull();
    expect(harness.values.has(key)).toBe(false);
    expect(harness.keys.size).toBe(0);
  });

  it('clears a stored value when its SecureStore key is missing', async () => {
    const harness = createHarness();
    const key = 'sb-project-auth-token';
    await harness.storage.setItem(key, 'sample-session');
    harness.keys.clear();

    await expect(harness.storage.getItem(key)).resolves.toBeNull();
    expect(harness.values.has(key)).toBe(false);
  });

  it('clears a stored value with an unknown envelope version', async () => {
    const harness = createHarness();
    const key = 'sb-project-auth-token';
    await harness.storage.setItem(key, 'sample-session');
    const bytes = decodeStoredValue(harness.values.get(key));
    bytes[0] = 2;
    harness.values.set(key, Buffer.from(bytes).toString('base64'));

    await expect(harness.storage.getItem(key)).resolves.toBeNull();
    expect(harness.values.has(key)).toBe(false);
    expect(harness.keys.size).toBe(0);
  });

  it('binds ciphertext to its storage key with AES-GCM associated data', async () => {
    const harness = createHarness();
    await harness.storage.setItem('first-auth-key', 'sample-session');
    harness.values.set('second-auth-key', harness.values.get('first-auth-key') ?? '');

    await expect(harness.storage.getItem('second-auth-key')).resolves.toBeNull();
    expect(harness.values.has('second-auth-key')).toBe(false);
    expect(harness.keys.size).toBe(1);
    expect(await harness.storage.getItem('first-auth-key')).toBe('sample-session');
  });

  it('removes only the requested item and its encryption key', async () => {
    const harness = createHarness();
    await harness.storage.setItem('first-auth-key', 'first-session');
    await harness.storage.setItem('second-auth-key', 'second-session');

    await harness.storage.removeItem('first-auth-key');

    expect(harness.values.has('first-auth-key')).toBe(false);
    expect(harness.values.has('second-auth-key')).toBe(true);
    expect(harness.keys.size).toBe(1);
    expect(await harness.storage.getItem('second-auth-key')).toBe('second-session');
  });
});
