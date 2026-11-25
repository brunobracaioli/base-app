import { describe, expect, it } from 'vitest';

import { GET } from './route';

describe('account deletion nonce guard', () => {
  it('returns a static 503 when no trusted request nonce is supplied', async () => {
    const response = GET(new Request('https://app.example/account-deletion'));
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).not.toContain('nonce-');
    expect(await response.text()).toContain('<h1>Service unavailable</h1>');
  });
});
