import { resolveBootRoute, runExtensionBootGates } from './resolve-boot';
import type { BootContext, BootGate } from '../../../extensions/types';

const context: BootContext = {
  config: {} as BootContext['config'],
  session: { userId: '5fa6acc4-75aa-4e60-8129-3db379c1c804', isAnonymous: false },
  me: { termsAccepted: true },
};

describe('boot resolution', () => {
  it('prioritizes update, maintenance, session, terms, then extension gates', async () => {
    expect(
      resolveBootRoute({
        updateRequired: true,
        maintenance: true,
        session: null,
        termsAccepted: false,
        extensionBlock: null,
      }),
    ).toBe('/(gates)/update');
    expect(
      resolveBootRoute({
        updateRequired: false,
        maintenance: true,
        session: null,
        termsAccepted: false,
        extensionBlock: null,
      }),
    ).toBe('/(gates)/maintenance');
    expect(
      resolveBootRoute({
        updateRequired: false,
        maintenance: false,
        session: null,
        termsAccepted: false,
        extensionBlock: null,
      }),
    ).toBe('/(auth)/welcome');
    expect(
      resolveBootRoute({
        updateRequired: false,
        maintenance: false,
        session: context.session,
        termsAccepted: false,
        extensionBlock: null,
      }),
    ).toBe('/(gates)/terms');
    expect(
      resolveBootRoute({
        updateRequired: false,
        maintenance: false,
        session: context.session,
        termsAccepted: true,
        extensionBlock: { href: '/(ext)/blocked' },
      }),
    ).toBe('/(ext)/blocked');
    expect(
      resolveBootRoute({
        updateRequired: false,
        maintenance: false,
        session: context.session,
        termsAccepted: true,
        extensionBlock: null,
      }),
    ).toBe('/(app)/(tabs)');
  });

  it('runs extension gates sequentially and turns failures into a blocking gate', async () => {
    const calls: string[] = [];
    const gates: BootGate[] = [
      {
        name: 'first',
        evaluate: () => {
          calls.push('first');
          return { status: 'pass' };
        },
      },
      {
        name: 'second',
        evaluate: () => {
          calls.push('second');
          throw new Error('private failure');
        },
      },
      {
        name: 'third',
        evaluate: () => {
          calls.push('third');
          return { status: 'pass' };
        },
      },
    ];

    await expect(runExtensionBootGates(context, gates)).resolves.toMatchObject({
      status: 'block',
      href: '/(gates)/extension-error',
      gateName: 'second',
    });
    expect(calls).toEqual(['first', 'second']);
  });
});
