import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';

import {
  LOCAL_PORTS,
  LOCAL_PROJECT_ID,
  MANAGED_BLOCK_END,
  MANAGED_BLOCK_START,
  buildLocalSupabaseConfig,
  generateLocalSecrets,
  generateLocalSigningKeys,
  isPrivateLanAddress,
  parseLocalSecrets,
  parseSupabaseStatus,
  pickLanAddress,
  publishedBindingsAreLoopback,
  routeGatewayRequest,
  stripUpstashOnlyScriptFlags,
  upsertManagedEnvBlock,
} from './local-stack.js';

describe('local Supabase config', () => {
  const source = [
    'project_id = "base-app"',
    '[api]',
    'enabled = false',
    '[auth]',
    'site_url = "https://example.invalid"',
    '[db.pooler]',
    'enabled = true',
    'port = 54329',
    '[local_smtp]',
    'enabled = true',
    'port = 54324',
  ].join('\n');

  it('moves every service to the dedicated ports, keeps the Data API off and adds signing keys', () => {
    // act
    type LocalConfig = {
      project_id: string;
      api: Record<string, unknown>;
      db: { port: number; pooler: { enabled: boolean } };
      studio: { enabled: boolean };
      local_smtp: { port: number };
      analytics: { enabled: boolean };
      edge_runtime: { enabled: boolean };
      auth: { site_url: string; signing_keys_path: string };
    };
    const local = parse(buildLocalSupabaseConfig(source)) as unknown as LocalConfig;

    // assert
    expect(local.project_id).toBe(LOCAL_PROJECT_ID);
    expect(local.api).toEqual({ enabled: false, port: LOCAL_PORTS.api });
    expect(local.db.port).toBe(LOCAL_PORTS.db);
    expect(local.studio.enabled).toBe(false);
    expect(local.db.pooler.enabled).toBe(false);
    expect(local.local_smtp.port).toBe(LOCAL_PORTS.mail);
    expect(local.analytics.enabled).toBe(false);
    expect(local.edge_runtime.enabled).toBe(false);
    expect(local.auth.site_url).toBe('https://example.invalid');
    expect(local.auth.signing_keys_path).toBe('./signing_keys.json');
  });
});

describe('local secrets', () => {
  it('generates ES256 signing keys accepted by the Supabase CLI format', () => {
    const [key] = JSON.parse(generateLocalSigningKeys()) as Record<string, unknown>[];
    expect(key).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
    expect(typeof key?.d).toBe('string');
    expect(typeof key?.kid).toBe('string');
  });

  it('round-trips generated secrets and rejects malformed files', () => {
    const secrets = generateLocalSecrets();
    expect(parseLocalSecrets(JSON.stringify(secrets))).toEqual(secrets);
    expect(parseLocalSecrets('{"apiRuntimePassword":"short"}')).toBeNull();
    expect(parseLocalSecrets('not json')).toBeNull();
  });
});

describe('LAN address selection', () => {
  const iface = (address: string, internal = false) => ({
    address,
    netmask: '255.255.255.0',
    family: 'IPv4' as const,
    mac: '00:00:00:00:00:00',
    internal,
    cidr: `${address}/24`,
  });

  it('prefers the home Wi-Fi range and skips loopback, Docker and virtual adapters', () => {
    expect(
      pickLanAddress({
        lo: [iface('127.0.0.1', true)],
        docker0: [iface('172.17.0.1')],
        'vEthernet (WSL)': [iface('172.28.80.1')],
        eth1: [iface('10.0.0.5')],
        'Wi-Fi': [iface('192.168.0.42')],
      }),
    ).toBe('192.168.0.42');
    expect(pickLanAddress({ eth0: [iface('10.1.2.3')] })).toBe('10.1.2.3');
    expect(pickLanAddress({ eth0: [iface('8.8.8.8')] })).toBeNull();
  });

  it('accepts only private IPv4 overrides', () => {
    expect(isPrivateLanAddress('192.168.1.10')).toBe(true);
    expect(isPrivateLanAddress('172.20.0.2')).toBe(true);
    expect(isPrivateLanAddress('203.0.113.7')).toBe(false);
    expect(isPrivateLanAddress('localhost')).toBe(false);
  });
});

describe('network gateway routing', () => {
  it.each([
    ['/auth/v1/otp', 'auth'],
    ['/auth/v1/verify', 'auth'],
    ['/auth/v1/token?grant_type=refresh_token', 'auth'],
    ['/auth/v1/user', 'auth'],
    ['/auth/v1/.well-known/jwks.json', 'auth'],
    ['/api/v1/me', 'api'],
    ['/api/v1/app-config', 'api'],
  ])('routes %s to %s', (url, target) => {
    expect(routeGatewayRequest(url)).toBe(target);
  });

  it.each([
    '/auth/v1/admin/users',
    '/auth/v1/invite',
    '/auth/v1/Admin/users',
    '/auth/v1/%61dmin/users',
    '/auth/v1/otp/../admin/users',
    '/auth/v1//admin/users',
    '/rest/v1/profiles',
    '/pg/tables',
    '/',
    '/project/default',
    'http://evil.example/api/v1/me',
    '/api\\v1',
  ])('refuses %s', (url) => {
    expect(routeGatewayRequest(url)).toBeNull();
  });
});

describe('managed env block', () => {
  it('appends the block, keeps student lines and replaces a previous block', () => {
    // arrange
    const first = upsertManagedEnvBlock('MY_FLAG=1\n', { APP_HOST: 'localhost:3000' });

    // act
    const second = upsertManagedEnvBlock(first, { APP_HOST: 'localhost:3001' });

    // assert
    expect(second).toBe(
      `MY_FLAG=1\n\n${MANAGED_BLOCK_START}\nAPP_HOST=localhost:3001\n${MANAGED_BLOCK_END}\n`,
    );
    expect(upsertManagedEnvBlock('', { A: 'b' })).toBe(
      `${MANAGED_BLOCK_START}\nA=b\n${MANAGED_BLOCK_END}\n`,
    );
  });

  it('refuses values that would inject extra lines', () => {
    expect(() => upsertManagedEnvBlock('', { A: 'x\nB=y' })).toThrow();
    expect(() => upsertManagedEnvBlock('', { 'bad key': 'x' })).toThrow();
  });
});

describe('Supabase status and port bindings', () => {
  it('reads only the public values from the status JSON', () => {
    const status = parseSupabaseStatus(
      'Stopped services: [x]\n{"API_URL":"http://127.0.0.1:58321","PUBLISHABLE_KEY":"sb_publishable_local","SECRET_KEY":"sb_secret_local","MAILPIT_URL":"http://127.0.0.1:58324"}',
    );
    expect(status).toEqual({
      apiUrl: 'http://127.0.0.1:58321',
      publishableKey: 'sb_publishable_local',
      studioUrl: null,
      mailUrl: 'http://127.0.0.1:58324',
    });
    expect(JSON.stringify(status)).not.toContain('sb_secret');
    expect(() => parseSupabaseStatus('{}')).toThrow();
  });

  it('detects any published port outside loopback', () => {
    expect(publishedBindingsAreLoopback(['127.0.0.1:58321->8000/tcp', '5432/tcp'])).toBe(true);
    expect(publishedBindingsAreLoopback(['0.0.0.0:58322->5432/tcp, [::]:58322->5432/tcp'])).toBe(
      false,
    );
  });
});

describe('local Redis proxy', () => {
  const script = '#!lua flags=allow-key-locking\n  local key = KEYS[1]\n';

  it('removes the Upstash-only flag from EVAL, pipelines and SCRIPT LOAD', () => {
    expect(
      JSON.parse(stripUpstashOnlyScriptFlags(JSON.stringify(['EVAL', script, 1, 'k']))),
    ).toEqual(['EVAL', '#!lua\n  local key = KEYS[1]\n', 1, 'k']);
    expect(
      JSON.parse(
        stripUpstashOnlyScriptFlags(
          JSON.stringify([
            ['eval', script, 0],
            ['SCRIPT', 'LOAD', '#!lua flags=no-writes,allow-key-locking\nreturn 1'],
          ]),
        ),
      ),
    ).toEqual([
      ['eval', '#!lua\n  local key = KEYS[1]\n', 0],
      ['SCRIPT', 'LOAD', '#!lua flags=no-writes\nreturn 1'],
    ]);
  });

  it('leaves other commands, EVALSHA and non-JSON bodies untouched', () => {
    const get = JSON.stringify(['GET', '#!lua flags=allow-key-locking']);
    expect(stripUpstashOnlyScriptFlags(get)).toBe(get);
    const evalsha = JSON.stringify(['EVALSHA', 'abc', 0]);
    expect(stripUpstashOnlyScriptFlags(evalsha)).toBe(evalsha);
    expect(stripUpstashOnlyScriptFlags('not json')).toBe('not json');
  });
});
