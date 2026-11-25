import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';
import {
  generateOrCheckSupabaseConfig,
  renderSupabaseConfig,
  SupabaseConfigError,
} from './supabase-config.js';

const baseConfig = `
project_id = "base-app"

[api]
enabled = false

[auth]
site_url = "https://example.invalid"
additional_redirect_urls = []
jwt_expiry = 900
enable_refresh_token_rotation = true
refresh_token_reuse_interval = 10
enable_signup = true
enable_anonymous_sign_ins = false
enable_manual_linking = false

[auth.email]
enabled = true
enable_confirmations = true
double_confirm_changes = true
secure_password_change = true
otp_length = 8
otp_expiry = 600

[auth.email.smtp]
enabled = false
host = "env(SMTP_HOST)"
pass = "env(RESEND_SMTP_PASSWORD)"

[auth.rate_limit]
email_sent = 60
sign_in_sign_ups = 30
token_verifications = 30

[auth.hook.before_user_created]
enabled = true
uri = "pg-functions://postgres/identity/before_user_created"

[auth.external.google]
enabled = false

[auth.external.slack_oidc]
enabled = false

[auth.sms]
enabled = false
enable_confirmations = false

[auth.mfa.totp]
enroll_enabled = false

[auth.oauth_server]
enabled = false

[auth.web3.solana]
enabled = false

[auth.captcha]
enabled = false

[db.pooler]
enabled = true
port = 54329
pool_mode = "transaction"
default_pool_size = 15
max_client_conn = 200
`;

const temporaryRoots: string[] = [];

async function makeSupabaseProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'base-app-supabase-config-'));
  temporaryRoots.push(root);
  await mkdir(path.join(root, 'supabase', 'config.d'), { recursive: true });
  await writeFile(path.join(root, 'supabase', 'config.base.toml'), baseConfig, 'utf8');
  await writeFile(path.join(root, 'supabase', 'config.d', '.gitkeep'), '', 'utf8');
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('Supabase TOML generator and invariant checker', () => {
  it('deep-merges fragments in lexical filename order and emits a stable override header', () => {
    const result = renderSupabaseConfig(baseConfig, [
      {
        name: '20-staging.toml',
        contents: ' [auth]\nsite_url = "https://staging.example.invalid"\n',
      },
      { name: '10-social.toml', contents: '[auth]\nsite_url = "https://social.example.invalid"\n' },
    ]);

    expect(result.coreOverrides).toEqual(['auth.site_url']);
    expect(result.text).toContain('#   - auth.site_url');
    expect(
      parseToml(
        result.text.slice(
          result.text.indexOf('\n', result.text.indexOf('# Approved allow-override keys:')) + 1,
        ),
      ).auth,
    ).toMatchObject({ site_url: 'https://staging.example.invalid' });
  });

  it('requires an exact allow-override marker for a protected key', () => {
    expect(() =>
      renderSupabaseConfig(baseConfig, [
        { name: '10-tighten-auth.toml', contents: '[auth]\njwt_expiry = 600\n' },
      ]),
    ).toThrow(/requires a preceding # allow-override marker/);
  });

  it('accepts marked protected changes that remain within the invariant', () => {
    const result = renderSupabaseConfig(baseConfig, [
      {
        name: '10-tighten-auth.toml',
        contents:
          '[auth]\n# allow-override: auth.jwt_expiry shorter token lifetime\njwt_expiry = 600\n',
      },
    ]);

    expect(result.approvedOverrides).toEqual(['auth.jwt_expiry']);
    expect(result.text).toContain('#   - auth.jwt_expiry');
  });

  it('rejects marker typos, orphan markers, duplicate markers and non-protected targets', () => {
    const cases = [
      '[auth]\n# allow-override: auth.jwt_expiry why\nadditional_redirect_urls = []\n',
      '[auth]\n# allow-override: auth.jwt_expiry why\njwt_expiry = 900\n',
      '[auth]\n# allow-override: auth.site_url why\nsite_url = "https://other.example.invalid"\n',
      '[auth]\n# allow-override: auth.jwt_expiry first\njwt_expiry = 600\n# allow-override: auth.jwt_expiry second\njwt_expiry = 500\n',
    ];
    for (const contents of cases)
      expect(() =>
        renderSupabaseConfig(baseConfig, [{ name: '10-invalid.toml', contents }]),
      ).toThrow(SupabaseConfigError);
  });

  it('enforces CAPTCHA for anonymous sign-ins and manual identity linking', () => {
    const marker = '# allow-override: auth.enable_anonymous_sign_ins enable guest flow';
    const noCaptcha = `[auth]\n${marker}\nenable_anonymous_sign_ins = true\n`;
    expect(() =>
      renderSupabaseConfig(baseConfig, [{ name: '10-guest.toml', contents: noCaptcha }]),
    ).toThrow(/requires auth.captcha.enabled/);

    const withCaptcha = `${noCaptcha}\n[auth.captcha]\n# allow-override: auth.captcha.enabled visitor verification\nenabled = true\nprovider = "turnstile"\nsecret = "env(TURNSTILE_SECRET)"\n`;
    const result = renderSupabaseConfig(baseConfig, [
      { name: '10-guest.toml', contents: withCaptcha },
    ]);
    expect(result.approvedOverrides).toEqual([
      'auth.captcha.enabled',
      'auth.enable_anonymous_sign_ins',
    ]);
  });

  it('rejects deprecated or unsupported Auth configuration keys', () => {
    const fragments = [
      '[auth.email]\nenable_signup = true\n',
      '[auth.sms]\nenable_signup = false\n',
      '[auth.external.slack]\nenabled = false\n',
      '[auth.saml]\nenabled = false\n',
    ];
    for (const contents of fragments) {
      expect(() =>
        renderSupabaseConfig(baseConfig, [{ name: '10-outdated-auth.toml', contents }]),
      ).toThrow(/unsupported or deprecated by the pinned Supabase CLI/);
    }
  });

  it('keeps the email provider and global signup enabled, SMS disabled, and a local transaction pooler', () => {
    const weakened = [
      '[auth]\n# allow-override: auth.enable_signup disabled signup\nenable_signup = false\n',
      '[auth.email]\n# allow-override: auth.email.enabled disabled email\nenabled = false\n',
      '[auth.sms]\n# allow-override: auth.sms.enabled enable SMS\nenabled = true\n',
      '[db.pooler]\n# allow-override: db.pooler.enabled disable local pooler\nenabled = false\n',
      '[db.pooler]\n# allow-override: db.pooler.pool_mode session mode\npool_mode = "session"\n',
    ];
    for (const contents of weakened) {
      expect(() =>
        renderSupabaseConfig(baseConfig, [{ name: '10-weakened-auth-or-db.toml', contents }]),
      ).toThrow(SupabaseConfigError);
    }
  });

  it('omits unused CAPTCHA provider and secret when CAPTCHA is disabled', () => {
    const result = renderSupabaseConfig(baseConfig, []);
    const generated = result.text.slice(
      result.text.indexOf('\n', result.text.indexOf('# Approved allow-override keys:')) + 1,
    );
    expect(parseToml(generated)).toMatchObject({ auth: { captcha: { enabled: false } } });
  });

  it('requires markers for redirect changes and rejects non-HTTPS or wildcard redirects', () => {
    const withoutMarker =
      '[auth]\nadditional_redirect_urls = ["https://accounts.example.invalid/callback"]\n';
    expect(() =>
      renderSupabaseConfig(baseConfig, [{ name: '10-redirect.toml', contents: withoutMarker }]),
    ).toThrow(/requires a preceding/);

    const valid =
      '[auth]\n# allow-override: auth.additional_redirect_urls provider callback\nadditional_redirect_urls = ["https://accounts.example.invalid/callback"]\n';
    expect(() =>
      renderSupabaseConfig(baseConfig, [{ name: '10-redirect.toml', contents: valid }]),
    ).not.toThrow();

    for (const url of [
      'http://accounts.example.invalid/callback',
      'https://*.example.invalid/callback',
    ]) {
      const invalid = `[auth]\n# allow-override: auth.additional_redirect_urls provider callback\nadditional_redirect_urls = ["${url}"]\n`;
      expect(() =>
        renderSupabaseConfig(baseConfig, [{ name: '10-redirect.toml', contents: invalid }]),
      ).toThrow(/explicit https URLs/);
    }
  });

  it('rejects literal SMTP and provider credentials in every fragment', () => {
    const fixtures = [
      '[auth.email.smtp]\npass = "SENSITIVE_TEST_MARKER"\n',
      '[auth.sms.twilio]\nauth_token = "SENSITIVE_TEST_MARKER"\n',
      '[auth.external.apple]\nsecret = "SENSITIVE_TEST_MARKER"\n',
    ];
    for (const contents of fixtures) {
      expect(() =>
        renderSupabaseConfig(baseConfig, [{ name: '10-provider.toml', contents }]),
      ).toThrow(/env\(NAME\) reference/);
    }
  });

  it('rejects TOML parser errors without echoing the source contents', () => {
    let caught: unknown;
    try {
      renderSupabaseConfig(baseConfig, [
        { name: '10-malformed.toml', contents: 'password = "SENSITIVE_TEST_MARKER"\ninvalid = [' },
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SupabaseConfigError);
    expect(caught instanceof Error ? caught.message : '').not.toContain('SENSITIVE_TEST_MARKER');
  });

  it('generates the committed config and checks exact drift without rewriting', async () => {
    const root = await makeSupabaseProject();
    const generated = await generateOrCheckSupabaseConfig(root, 'generate');
    expect(generated.mode).toBe('generated');
    expect(await readFile(path.join(root, 'supabase', 'config.toml'), 'utf8')).toContain(
      '# Generated by pnpm supabase:config',
    );

    const checked = await generateOrCheckSupabaseConfig(root, 'check');
    expect(checked.mode).toBe('checked');

    await writeFile(path.join(root, 'supabase', 'config.toml'), '# manual edit\n', 'utf8');
    await expect(generateOrCheckSupabaseConfig(root, 'check')).rejects.toThrow(/out of date/);
  });

  it.each(['config.json', 'config.jsonc'])('rejects the shadow config file %s', async (name) => {
    const root = await makeSupabaseProject();
    await writeFile(path.join(root, 'supabase', name), '{}', 'utf8');
    await expect(generateOrCheckSupabaseConfig(root, 'generate')).rejects.toThrow(
      /precedence over config.toml/,
    );
  });
});
