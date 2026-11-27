import { CaptchaError, type CaptchaProvider, type CaptchaToken } from '../../../extensions/types';
import { withCaptcha } from './with-captcha';

const token: CaptchaToken = { token: 'ephemeral-test-token', issuedAt: 1 };

function createProvider(): CaptchaProvider {
  return {
    kind: 'test',
    prewarm: jest.fn(),
    getToken: jest.fn(async () => token),
    release: jest.fn(),
    dispose: jest.fn(),
  };
}

describe('withCaptcha', () => {
  it('calls the Auth operation without a captchaToken when no provider exists', async () => {
    const call = jest.fn(async (captchaToken: string | undefined) => captchaToken);

    await expect(withCaptcha(null, 'sign_in_otp', call)).resolves.toBeUndefined();

    expect(call).toHaveBeenCalledWith(undefined);
  });

  it('returns the mapped Auth result before releasing a failed token', async () => {
    const provider = createProvider();
    const mappedResult = { ok: false as const, error: 'auth.failed' as const };
    const call = jest.fn(async (captchaToken: string | undefined) => {
      expect(captchaToken).toBe(token.token);
      return mappedResult;
    });

    await expect(withCaptcha(provider, 'sign_up', call)).resolves.toBe(mappedResult);

    expect(provider.getToken).toHaveBeenCalledWith('sign_up');
    expect(provider.release).toHaveBeenCalledWith(token);
  });

  it('keeps a captcha token after a mapped successful Auth result', async () => {
    const provider = createProvider();
    const mappedResult = { ok: true as const, value: undefined };

    await expect(
      withCaptcha(provider, 'sign_in_password', async (captchaToken) => {
        expect(captchaToken).toBe(token.token);
        return mappedResult;
      }),
    ).resolves.toBe(mappedResult);

    expect(provider.release).not.toHaveBeenCalled();
  });

  it('does not call Auth and propagates a provider failure', async () => {
    const provider = createProvider();
    provider.getToken = jest.fn().mockRejectedValue(new CaptchaError('timeout'));
    const call = jest.fn();

    await expect(withCaptcha(provider, 'reauth', call)).rejects.toMatchObject({
      code: 'timeout',
    });

    expect(call).not.toHaveBeenCalled();
    expect(provider.release).not.toHaveBeenCalled();
  });

  it('releases a token when the Auth call throws', async () => {
    const provider = createProvider();
    const call = jest.fn().mockRejectedValue(new Error('private SDK response'));

    await expect(withCaptcha(provider, 'resend', call)).rejects.toThrow('private SDK response');

    expect(provider.release).toHaveBeenCalledWith(token);
  });
});
