import { isIP } from 'node:net';
import { ipAddress as vercelIpAddress } from '@vercel/functions';

function ipv4Address(value: string): string | null {
  return isIP(value) === 4
    ? value
        .split('.')
        .map((part) => String(Number(part)))
        .join('.')
    : null;
}

function expandIpv6(value: string): string[] | null {
  let address = value.toLowerCase().split('%', 1)[0] ?? '';
  const lastColon = address.lastIndexOf(':');
  const embeddedIpv4 = address.slice(lastColon + 1);
  if (embeddedIpv4.includes('.')) {
    const ipv4 = ipv4Address(embeddedIpv4);
    if (!ipv4) return null;
    const octets = ipv4.split('.').map(Number);
    const high = (((octets[0] ?? 0) << 8) | (octets[1] ?? 0)).toString(16);
    const low = (((octets[2] ?? 0) << 8) | (octets[3] ?? 0)).toString(16);
    address = `${address.slice(0, lastColon + 1)}${high}:${low}`;
  }

  if (address.includes(':::')) return null;
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const parts = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  return parts.length === 8 && parts.every((part) => /^[0-9a-f]{1,4}$/.test(part))
    ? parts.map((part) => part.padStart(4, '0'))
    : null;
}

export function normalizeIpAddress(value: string): string | null {
  const candidate = value.trim().replace(/^\[|\]$/g, '');
  const ipv4 = ipv4Address(candidate);
  if (ipv4) return ipv4;
  if (isIP(candidate.split('%', 1)[0] ?? '') !== 6) return null;
  const parts = expandIpv6(candidate);
  if (!parts) return null;

  if (parts.slice(0, 5).every((part) => part === '0000') && parts[5] === 'ffff') {
    const high = Number.parseInt(parts[6] ?? '0', 16);
    const low = Number.parseInt(parts[7] ?? '0', 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return `${parts.slice(0, 4).join(':')}/64`;
}

export function ipAddress(request: Request): string {
  return normalizeIpAddress(vercelIpAddress(request) ?? '') ?? 'unknown';
}
