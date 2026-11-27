import { gcm } from '@noble/ciphers/aes.js';

const KEY_STORAGE_PREFIX = 'base-app.auth-encryption-key.v1.';
const ENVELOPE_VERSION = 1;
const AES_KEY_BYTES = 32;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const MAX_ENVELOPE_BYTES = 4 * 1024 * 1024;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type AuthStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

type AsyncStoragePort = Pick<
  (typeof import('@react-native-async-storage/async-storage'))['default'],
  'getItem' | 'setItem' | 'removeItem'
>;
type SecureStoreModule = typeof import('expo-secure-store');
type SecureStorePort = Pick<
  SecureStoreModule,
  'getItemAsync' | 'setItemAsync' | 'deleteItemAsync' | 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY'
>;

export type EncryptedStorageDependencies = {
  readonly asyncStorage?: AsyncStoragePort;
  readonly secureStore?: SecureStorePort;
  readonly randomBytes?: (byteCount: number) => Promise<Uint8Array>;
};

function encodeBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  const chunkSize = 8192;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return globalThis.btoa(chunks.join(''));
}

function decodeBase64(value: string): Uint8Array {
  if (value.length === 0 || value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) {
    throw new Error('Invalid encoded storage value.');
  }
  const decoded = globalThis.atob(value);
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (encodeBase64(bytes) !== value) {
    throw new Error('Invalid encoded storage value.');
  }
  return bytes;
}

function secureStoreKeyFor(storageKey: string): string {
  const encodedKey = encodeBase64(new TextEncoder().encode(storageKey))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return `${KEY_STORAGE_PREFIX}${encodedKey}`;
}

function copyBytes(source: Uint8Array): Uint8Array {
  return new Uint8Array(source);
}

function createStorageError(): Error {
  return new Error('Authentication storage is unavailable.');
}

export function createEncryptedStorage(
  dependencies: EncryptedStorageDependencies = {},
): AuthStorage {
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder('utf-8', { fatal: true });
  let queuedOperations: Promise<void> = Promise.resolve();

  async function getAsyncStorage(): Promise<AsyncStoragePort> {
    if (dependencies.asyncStorage !== undefined) return dependencies.asyncStorage;
    const module = await import('@react-native-async-storage/async-storage');
    return module.default;
  }

  async function getSecureStore(): Promise<SecureStorePort> {
    if (dependencies.secureStore !== undefined) return dependencies.secureStore;
    return import('expo-secure-store');
  }

  async function getRandomBytes(byteCount: number): Promise<Uint8Array> {
    if (dependencies.randomBytes !== undefined) return dependencies.randomBytes(byteCount);
    const Crypto = await import('expo-crypto');
    return Crypto.getRandomBytesAsync(byteCount);
  }

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = queuedOperations.then(operation);
    queuedOperations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function readExistingKey(storageKey: string): Promise<Uint8Array | null> {
    const secureStore = await getSecureStore();
    const storedKey = await secureStore.getItemAsync(secureStoreKeyFor(storageKey));
    if (storedKey === null) return null;
    try {
      const key = decodeBase64(storedKey);
      return key.length === AES_KEY_BYTES ? key : null;
    } catch {
      return null;
    }
  }

  async function getOrCreateKey(storageKey: string): Promise<Uint8Array> {
    const secureStore = await getSecureStore();
    const keyName = secureStoreKeyFor(storageKey);
    const storedKey = await secureStore.getItemAsync(keyName);
    if (storedKey !== null) {
      try {
        const existingKey = decodeBase64(storedKey);
        if (existingKey.length === AES_KEY_BYTES) return existingKey;
      } catch {
        // Replace invalid key material before storing a new encrypted value.
      }
    }

    const key = await getRandomBytes(AES_KEY_BYTES);
    if (key.length !== AES_KEY_BYTES) throw createStorageError();
    await secureStore.setItemAsync(keyName, encodeBase64(key), {
      keychainAccessible: secureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    });
    return copyBytes(key);
  }

  async function removeItemAndKey(storageKey: string): Promise<void> {
    const [asyncStorage, secureStore] = await Promise.all([getAsyncStorage(), getSecureStore()]);
    const results = await Promise.allSettled([
      asyncStorage.removeItem(storageKey),
      secureStore.deleteItemAsync(secureStoreKeyFor(storageKey)),
    ]);
    if (results.some((result) => result.status === 'rejected')) {
      throw createStorageError();
    }
  }

  async function clearCorruptItem(storageKey: string): Promise<void> {
    try {
      await removeItemAndKey(storageKey);
    } catch {
      // A failed cleanup still returns a missing session; corrupt data is never reused.
    }
  }

  function decrypt(storageKey: string, encodedValue: string, key: Uint8Array): string {
    if (encodedValue.length > MAX_ENVELOPE_BYTES * 2) {
      throw new Error('Stored value exceeds the supported size.');
    }
    const envelope = decodeBase64(encodedValue);
    const minEnvelopeBytes = 1 + GCM_NONCE_BYTES + GCM_TAG_BYTES;
    if (envelope.length < minEnvelopeBytes || envelope.length > MAX_ENVELOPE_BYTES) {
      throw new Error('Invalid encrypted storage envelope.');
    }
    if (envelope[0] !== ENVELOPE_VERSION) {
      throw new Error('Unsupported encrypted storage version.');
    }

    const nonce = envelope.subarray(1, 1 + GCM_NONCE_BYTES);
    const ciphertextWithTag = envelope.subarray(1 + GCM_NONCE_BYTES);
    const plaintext = gcm(key, nonce, textEncoder.encode(storageKey)).decrypt(ciphertextWithTag);
    return textDecoder.decode(plaintext);
  }

  return {
    getItem(storageKey) {
      return serialize(async () => {
        try {
          const asyncStorage = await getAsyncStorage();
          const value = await asyncStorage.getItem(storageKey);
          if (value === null) return null;
          const key = await readExistingKey(storageKey);
          if (key === null) {
            await clearCorruptItem(storageKey);
            return null;
          }
          return decrypt(storageKey, value, key);
        } catch {
          await clearCorruptItem(storageKey);
          return null;
        }
      });
    },
    setItem(storageKey, value) {
      return serialize(async () => {
        try {
          const key = await getOrCreateKey(storageKey);
          const nonce = await getRandomBytes(GCM_NONCE_BYTES);
          if (nonce.length !== GCM_NONCE_BYTES) throw createStorageError();
          const encrypted = gcm(key, nonce, textEncoder.encode(storageKey)).encrypt(
            textEncoder.encode(value),
          );
          const envelope = new Uint8Array(1 + nonce.length + encrypted.length);
          envelope[0] = ENVELOPE_VERSION;
          envelope.set(nonce, 1);
          envelope.set(encrypted, 1 + nonce.length);
          const asyncStorage = await getAsyncStorage();
          await asyncStorage.setItem(storageKey, encodeBase64(envelope));
        } catch {
          throw createStorageError();
        }
      });
    },
    removeItem(storageKey) {
      return serialize(async () => {
        try {
          await removeItemAndKey(storageKey);
        } catch {
          throw createStorageError();
        }
      });
    },
  };
}

export const encryptedStorage = createEncryptedStorage();
