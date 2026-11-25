import { createOpenExternalUrl } from './open-external-url';

describe('openExternalUrl', () => {
  it('accepts only HTTPS URLs on the explicit product/store/provider allowlist', async () => {
    const openUrl = jest.fn().mockResolvedValue(undefined);
    const open = createOpenExternalUrl({
      allowedOrigins: ['https://myapp.example.invalid'],
      openUrl,
    });

    await expect(open('https://myapp.example.invalid/legal')).resolves.toBe(true);
    await expect(open('https://apps.apple.com/app/example')).resolves.toBe(true);
    await expect(
      open('https://play.google.com/store/apps/details?id=com.example.app'),
    ).resolves.toBe(true);
    await expect(open('https://checkout.revenuecat.com/offer')).resolves.toBe(true);
    await expect(open('https://offer.rev.cat/path')).resolves.toBe(true);
    expect(openUrl).toHaveBeenCalledTimes(5);
  });

  it.each([
    'http://myapp.example.invalid',
    'javascript:alert(1)',
    'https://attacker.invalid/path',
    'https://fake-revenuecat.com/path',
    'not a url',
  ])('rejects unsafe URL %s', async (url) => {
    const openUrl = jest.fn();
    const open = createOpenExternalUrl({
      allowedOrigins: ['https://myapp.example.invalid'],
      openUrl,
    });

    await expect(open(url)).resolves.toBe(false);
    expect(openUrl).not.toHaveBeenCalled();
  });
});
