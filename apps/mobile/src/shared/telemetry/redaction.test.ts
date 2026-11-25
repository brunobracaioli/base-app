import { redactTelemetryEvent, redactTelemetryBreadcrumb } from './redaction';

describe('telemetry redaction', () => {
  it('removes email, code, token, secret, and password values from nested events', () => {
    const event = redactTelemetryEvent({
      message:
        'login code=123456 bearer eyJhbGciOiJIUzI1NiJ9.payload.signature user@example.invalid',
      user: { id: '5fa6acc4-75aa-4e60-8129-3db379c1c804', email: 'user@example.invalid' },
      extra: { code: '123456', accessToken: 'secret-token', password: 'secret-password' },
    });

    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('user@example.invalid');
    expect(serialized).not.toContain('123456');
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('secret-password');
    expect(serialized).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(event).toMatchObject({ user: { id: '5fa6acc4-75aa-4e60-8129-3db379c1c804' } });
  });

  it('drops navigation breadcrumb route data and sanitizes other breadcrumb content', () => {
    expect(
      redactTelemetryBreadcrumb({ category: 'navigation', data: { email: 'a@b.invalid' } }),
    ).toBeNull();
    expect(
      JSON.stringify(
        redactTelemetryBreadcrumb({ message: 'token=secret-token', data: { safe: 'ok' } }),
      ),
    ).not.toContain('secret-token');
  });
});
