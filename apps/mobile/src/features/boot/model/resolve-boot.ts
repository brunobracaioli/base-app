import type { BootContext, BootGate, BootGateResult } from '../../../extensions/types';

export type BootRouteInput = {
  readonly updateRequired: boolean;
  readonly maintenance: boolean;
  readonly session: BootContext['session'];
  readonly termsAccepted: boolean;
  readonly offline?: boolean;
  readonly extensionBlock: { readonly href: string } | null;
};

export function resolveBootRoute(input: BootRouteInput): string {
  if (input.updateRequired) {
    return '/(gates)/update';
  }
  if (input.maintenance) {
    return '/(gates)/maintenance';
  }
  if (input.session === null) {
    return '/(auth)/welcome';
  }
  if (!input.termsAccepted && input.offline !== true) {
    return '/(gates)/terms';
  }
  if (input.extensionBlock !== null) {
    return input.extensionBlock.href;
  }
  return '/(app)/(tabs)';
}

export type ExtensionGateRun =
  | { readonly status: 'pass' }
  | { readonly status: 'block'; readonly href: string; readonly gateName: string };

export async function runExtensionBootGates(
  context: BootContext,
  gates: readonly BootGate[],
): Promise<ExtensionGateRun> {
  for (const gate of gates) {
    let result: BootGateResult;
    try {
      result = await gate.evaluate(context);
    } catch {
      return { status: 'block', href: '/(gates)/extension-error', gateName: gate.name };
    }

    if (result.status === 'block') {
      return { status: 'block', href: result.href, gateName: gate.name };
    }
  }

  return { status: 'pass' };
}
