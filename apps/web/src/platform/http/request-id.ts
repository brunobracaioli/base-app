import { randomBytes } from 'node:crypto';

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string | null): value is string {
  return value !== null && UUID_PATTERN.test(value);
}

export function createUuidV7(
  nowMs = Date.now(),
  random: (size: number) => Uint8Array = (size) => randomBytes(size),
): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs >= 2 ** 48) {
    throw new RangeError('UUIDv7 timestamp is out of range.');
  }
  const bytes = Uint8Array.from(random(16));
  if (bytes.length !== 16) throw new RangeError('UUIDv7 requires 16 random bytes.');

  let timestamp = BigInt(nowMs);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const value = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  if (!UUID_V7_PATTERN.test(value)) throw new Error('Generated UUIDv7 did not pass validation.');
  return value;
}
