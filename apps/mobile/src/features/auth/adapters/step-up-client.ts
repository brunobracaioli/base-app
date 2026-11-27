import type { AuthStorage } from './encrypted-storage';
import { createSupabaseClient } from './supabase-client';
import type { AuthClientConfig } from './supabase-client';

export function createIsolatedAuthStorage(): AuthStorage {
  const values = new Map<string, string>();
  return {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value);
    },
    removeItem: async (key) => {
      values.delete(key);
    },
  };
}

export function createStepUpClient(config: Omit<AuthClientConfig, 'persistSession'>) {
  return createSupabaseClient({
    ...config,
    storage: createIsolatedAuthStorage(),
    persistSession: false,
  });
}
