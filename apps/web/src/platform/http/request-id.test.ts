import { describe, expect, it } from 'vitest';

import { createUuidV7, isUuid, UUID_V7_PATTERN } from './request-id';

describe('UUIDv7 request IDs', () => {
  it('injects timestamp and randomness for deterministic tests', () => {
    const id = createUuidV7(0, () => new Uint8Array(16));
    expect(id).toBe('00000000-0000-7000-8000-000000000000');
    expect(UUID_V7_PATTERN.test(id)).toBe(true);
  });

  it('recognizes a valid client UUID without treating it as a request ID', () => {
    expect(isUuid('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
  });
});
