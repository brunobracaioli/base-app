import { Webhook } from 'standardwebhooks';
import { describe, expect, it } from 'vitest';

import type { AppLogger } from '../observability/logger';
import { sharedSecret, standardWebhooks } from './webhook-verifiers';

const NOW = new Date('2026-11-24T12:00:00.000Z');
const CURRENT_SECRET = 'test-only-current-secret-never-used-outside-this-test';
const PREVIOUS_SECRET = 'test-only-previous-secret-never-used-outside-this-test';
const silentLogger: AppLogger = { info() {}, warn() {}, error() {} };

function requestWithBearer(secret: string): Request {
  return new Request('https://app.example/webhook', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}` },
    body: '{}',
  });
}

describe('shared-secret webhook verifier', () => {
  it('accepts the current and unexpired previous secrets and rejects unknown values', async () => {
    const verifier = sharedSecret(
      ['WEBHOOK_CURRENT', 'WEBHOOK_PREVIOUS'],
      {
        WEBHOOK_CURRENT: CURRENT_SECRET,
        WEBHOOK_PREVIOUS: PREVIOUS_SECRET,
        WEBHOOK_PREVIOUS_EXPIRES_AT: '2026-12-01T00:00:00.000Z',
      },
      NOW,
      silentLogger,
    );
    const body = new TextEncoder().encode('{}');
    expect(await verifier({ request: requestWithBearer(CURRENT_SECRET), body, now: NOW })).toBe(
      true,
    );
    expect(await verifier({ request: requestWithBearer(PREVIOUS_SECRET), body, now: NOW })).toBe(
      true,
    );
    expect(await verifier({ request: requestWithBearer('unknown-secret'), body, now: NOW })).toBe(
      false,
    );
  });

  it('rejects expired rotated secrets and validates rotation count and expiry', async () => {
    const verifier = sharedSecret(
      ['WEBHOOK_CURRENT', 'WEBHOOK_PREVIOUS'],
      {
        WEBHOOK_CURRENT: CURRENT_SECRET,
        WEBHOOK_PREVIOUS: PREVIOUS_SECRET,
        WEBHOOK_PREVIOUS_EXPIRES_AT: '2026-11-24T11:59:59.000Z',
      },
      NOW,
      silentLogger,
    );
    expect(
      await verifier({
        request: requestWithBearer(PREVIOUS_SECRET),
        body: new Uint8Array(),
        now: NOW,
      }),
    ).toBe(false);

    expect(() =>
      sharedSecret(
        ['A', 'B', 'C', 'D'],
        {
          A: 'a',
          B: 'b',
          B_EXPIRES_AT: '2026-11-25T00:00:00.000Z',
          C: 'c',
          C_EXPIRES_AT: '2026-11-25T00:00:00.000Z',
          D: 'd',
          D_EXPIRES_AT: '2026-11-25T00:00:00.000Z',
        },
        NOW,
      ),
    ).toThrow(/at most three/);
    expect(() => sharedSecret(['A', 'B'], { A: 'a', B: 'b' }, NOW)).toThrow(/_EXPIRES_AT/);
    expect(() =>
      sharedSecret(['A', 'B'], { A: 'a', B: 'b', B_EXPIRES_AT: '2027-01-01T00:00:00.000Z' }, NOW),
    ).toThrow(/30 days/);
    expect(() =>
      sharedSecret(['A', 'B'], { A: 'a', B: 'b', B_EXPIRES_AT: '2026/11/25' }, NOW),
    ).toThrow(/ISO 8601/);
  });
});

describe('Standard Webhooks verifier', () => {
  it('verifies the raw body against the signed headers', async () => {
    const secret = Buffer.from('generated-test-only-webhook-secret').toString('base64');
    const webhook = new Webhook(secret);
    const messageId = 'msg_test_only';
    const timestamp = new Date();
    const body = new TextEncoder().encode('{"event":"test"}');
    const signature = webhook.sign(messageId, timestamp, body);
    const request = new Request('https://app.example/webhook', {
      method: 'POST',
      headers: {
        'webhook-id': messageId,
        'webhook-timestamp': String(Math.floor(timestamp.getTime() / 1_000)),
        'webhook-signature': signature,
      },
      body: new TextDecoder().decode(body),
    });
    const verifier = standardWebhooks(
      ['WEBHOOK_SIGNING_SECRET'],
      { WEBHOOK_SIGNING_SECRET: secret },
      timestamp,
    );
    expect(await verifier({ request, body, now: timestamp })).toBe(true);
  });

  it('rejects a signature for a different raw body', async () => {
    const secret = Buffer.from('generated-test-only-webhook-secret').toString('base64');
    const webhook = new Webhook(secret);
    const messageId = 'msg_test_only';
    const timestamp = new Date();
    const signature = webhook.sign(messageId, timestamp, '{"event":"signed"}');
    const request = new Request('https://app.example/webhook', {
      method: 'POST',
      headers: {
        'webhook-id': messageId,
        'webhook-timestamp': String(Math.floor(timestamp.getTime() / 1_000)),
        'webhook-signature': signature,
      },
      body: '{"event":"different"}',
    });
    const verifier = standardWebhooks(
      ['WEBHOOK_SIGNING_SECRET'],
      { WEBHOOK_SIGNING_SECRET: secret },
      timestamp,
    );
    expect(
      await verifier({
        request,
        body: new TextEncoder().encode('{"event":"different"}'),
        now: timestamp,
      }),
    ).toBe(false);
  });
});
