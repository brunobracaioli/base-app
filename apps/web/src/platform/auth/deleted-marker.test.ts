import { describe, expect, it } from 'vitest';

import { createDeletedAccountMarkerReader } from './deleted-marker';

describe('deleted account marker reader', () => {
  it('checks the versioned auth marker key and treats only an existing marker as deleted', async () => {
    const keys: string[] = [];
    let exists = 0;
    const reader = createDeletedAccountMarkerReader({
      async exists(key) {
        keys.push(key);
        return exists;
      },
    });

    expect(await reader.isDeleted('c4a76084-7818-42af-a4bb-4146655a8d31')).toBe(false);
    exists = 1;
    expect(await reader.isDeleted('c4a76084-7818-42af-a4bb-4146655a8d31')).toBe(true);
    expect(keys).toEqual([
      'auth:deleted:v1:c4a76084-7818-42af-a4bb-4146655a8d31',
      'auth:deleted:v1:c4a76084-7818-42af-a4bb-4146655a8d31',
    ]);
  });

  it('propagates store errors so the verifier can fail closed', async () => {
    const reader = createDeletedAccountMarkerReader({
      async exists() {
        throw new Error('backend detail');
      },
    });

    await expect(reader.isDeleted('c4a76084-7818-42af-a4bb-4146655a8d31')).rejects.toThrow(
      'backend detail',
    );
  });

  it('rejects an invalid existence count rather than treating it as an absent marker', async () => {
    const reader = createDeletedAccountMarkerReader({
      async exists() {
        return Number.NaN;
      },
    });

    await expect(reader.isDeleted('c4a76084-7818-42af-a4bb-4146655a8d31')).rejects.toThrow(
      'Deleted account marker response is invalid.',
    );
  });
});
