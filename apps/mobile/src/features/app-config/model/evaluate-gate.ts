import type { AppConfigResponseValue, PlatformValue } from '@base-app/contracts';

export type AppConfigGate = 'ok' | 'update' | 'maintenance';

export type EvaluateGateInput = {
  readonly appVersion: string;
  readonly platform: PlatformValue;
  readonly offline?: boolean;
};

function normalizeComponent(value: string): string {
  return value.replace(/^0+/, '') || '0';
}

function compareVersionComponents(left: string, right: string): number {
  const normalizedLeft = normalizeComponent(left);
  const normalizedRight = normalizeComponent(right);
  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedLeft.length < normalizedRight.length ? -1 : 1;
  }
  if (normalizedLeft === normalizedRight) return 0;
  return normalizedLeft < normalizedRight ? -1 : 1;
}

export function compareNumericVersions(left: string, right: string): number {
  const leftComponents = /^\d+\.\d+\.\d+$/.test(left) ? left.split('.') : ['0', '0', '0'];
  const rightComponents = /^\d+\.\d+\.\d+$/.test(right) ? right.split('.') : ['0', '0', '0'];

  for (let index = 0; index < 3; index += 1) {
    const comparison = compareVersionComponents(
      leftComponents[index] ?? '0',
      rightComponents[index] ?? '0',
    );
    if (comparison !== 0) return comparison;
  }

  return 0;
}

export function evaluateGate(
  config: AppConfigResponseValue,
  input: EvaluateGateInput,
): AppConfigGate {
  if (!/^\d+\.\d+\.\d+$/.test(input.appVersion)) {
    return 'update';
  }

  if (compareNumericVersions(input.appVersion, config.versions[input.platform].minSupported) < 0) {
    return 'update';
  }

  if (
    input.offline !== true &&
    config.maintenance.active &&
    config.maintenance.platforms.includes(input.platform)
  ) {
    return 'maintenance';
  }

  return 'ok';
}
