import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { createLogger } from './logger';
import { redactSentryEvent } from './redaction';

describe('structured logging and Sentry redaction', () => {
  it('removes token, email and password values from structured logs and messages', () => {
    const chunks: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk.toString('utf8'));
        callback();
      },
    });
    const logger = createLogger(destination, 'info');
    logger.info('Login for test-user@example.test', {
      token: 'generated-test-only-token',
      email: 'test-user@example.test',
      password: 'generated-test-only-password',
      requestId: '00000000-0000-7000-8000-000000000001',
    });

    const output = chunks.join('');
    expect(output).not.toContain('generated-test-only-token');
    expect(output).not.toContain('test-user@example.test');
    expect(output).not.toContain('generated-test-only-password');
    expect(output).toContain('00000000-0000-7000-8000-000000000001');
  });

  it('removes request bodies, credentials, query strings and PII from Sentry events', () => {
    const event = redactSentryEvent({
      message: 'Failure for test-user@example.test',
      request: {
        url: 'https://app.example/path?email=test-user%40example.test',
        data: { password: 'generated-test-only-password' },
        cookies: 'generated-test-only-cookie',
        headers: {
          authorization: 'Bearer generated-test-only-token',
          'x-safe': 'ok',
        },
      },
      user: { id: '11111111-1111-4111-8111-111111111111', email: 'test-user@example.test' },
    });
    const output = JSON.stringify(event);
    expect(output).not.toContain('test-user@example.test');
    expect(output).not.toContain('generated-test-only-token');
    expect(output).not.toContain('generated-test-only-password');
    expect(output).not.toContain('generated-test-only-cookie');
    expect(output).not.toContain('?email=');
    expect(output).toContain('11111111-1111-4111-8111-111111111111');
  });
});
