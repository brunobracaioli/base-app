import { describe, expect, it } from 'vitest';
import { APP_CONFIG_KEYS } from '../../src/modules/app-config';
import {
  AppConfigOperationError,
  createAppConfigPlanner,
  parseJsonValue,
  parseRollbackArguments,
  parseSetArguments,
  planRollback,
  planSetChange,
  toSafeOperationFailure,
  type AppConfigKey,
  type CurrentSettingSnapshot,
  type RollbackSource,
} from './operation';

const currentVersions = {
  ios: { minSupported: '1.0.0', latest: '2.3.0', published: '2.2.0' },
  android: { minSupported: '1.0.0', latest: '2.3.0', published: '2.2.0' },
};

function snapshot(value: unknown, updatedAt: string | null): CurrentSettingSnapshot {
  return { value, updatedAt };
}

function versionsWithMinSupported(version: string, latest = '2.3.0') {
  return {
    ios: { ...currentVersions.ios, minSupported: version, latest },
    android: { ...currentVersions.android, minSupported: version, latest },
  };
}

describe('app-config operator argument parsing', () => {
  it('accepts exactly one JSON or file source and exposes force as a plan option', () => {
    expect(APP_CONFIG_KEYS).toEqual(['versions', 'maintenance', 'legal']);
    expect(
      parseSetArguments(['versions', '--json', '{"ios":{},"android":{}}', '--dry-run', '--force']),
    ).toEqual({
      key: 'versions',
      source: { kind: 'json', value: '{"ios":{},"android":{}}' },
      dryRun: true,
      force: true,
    });
    expect(parseSetArguments(['legal', '--file', 'legal.json'])).toEqual({
      key: 'legal',
      source: { kind: 'file', path: 'legal.json' },
      dryRun: false,
      force: false,
    });
  });

  it('rejects unknown keys, duplicate sources, and mutation flags on rollback', () => {
    expect(() => parseSetArguments(['unknown', '--json', '{}'])).toThrow(AppConfigOperationError);
    expect(() => parseSetArguments(['legal', '--json', '{}', '--file', 'legal.json'])).toThrow(
      AppConfigOperationError,
    );
    expect(() => parseRollbackArguments(['legal', '--force'])).toThrow(AppConfigOperationError);
  });

  it('maps invalid JSON to a stable input error without echoing the supplied value', () => {
    const secretLikeInput = '{"unexpected":"should-not-appear-in-errors","';
    try {
      parseJsonValue(secretLikeInput);
      throw new Error('Expected invalid JSON to be rejected.');
    } catch (error) {
      expect(error).toBeInstanceOf(AppConfigOperationError);
      expect((error as Error).message).not.toContain('should-not-appear-in-errors');
    }
  });

  it('rejects over-sized JSON before parsing it', () => {
    expect(() => parseJsonValue(' '.repeat(2049))).toThrow(AppConfigOperationError);
  });
});

describe('app-config set planning', () => {
  const key: AppConfigKey = 'versions';
  const currentUpdatedAt = '2026-11-25T12:34:56.123456+00:00';

  it('builds a deterministic diff and preserves the exact PostgreSQL CAS timestamp', () => {
    const plan = planSetChange({
      key,
      proposedValue: versionsWithMinSupported('2.0.0'),
      current: snapshot(currentVersions, currentUpdatedAt),
      force: false,
      now: new Date('2026-11-25T12:00:00.000Z'),
    });

    expect(plan.before).toEqual(currentVersions);
    expect(plan.after).toEqual(versionsWithMinSupported('2.0.0'));
    expect(plan.expectedUpdatedAt).toBe(currentUpdatedAt);
    expect(plan.force).toBe(false);
    expect(plan.diff).toContain('ios.minSupported');
    expect(plan.diff).not.toContain('published');
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.after)).toBe(true);
    const immutableVersions = plan.after as { readonly ios: object; readonly android: object };
    expect(Object.isFrozen(immutableVersions.ios)).toBe(true);
  });

  it('rejects a minSupported jump beyond the stored latest version unless force was requested', () => {
    expect(() =>
      planSetChange({
        key,
        proposedValue: versionsWithMinSupported('2.4.0', '2.4.0'),
        current: snapshot(currentVersions, currentUpdatedAt),
        force: false,
        now: new Date('2026-11-25T12:00:00.000Z'),
      }),
    ).toThrow(AppConfigOperationError);

    const plan = planSetChange({
      key,
      proposedValue: versionsWithMinSupported('2.4.0', '2.4.0'),
      current: snapshot(currentVersions, currentUpdatedAt),
      force: true,
      now: new Date('2026-11-25T12:00:00.000Z'),
    });
    expect(plan.force).toBe(true);
    expect(plan.forceReasons).toContain('version_jump');
  });

  it('compares version components numerically for the stored latest guard', () => {
    const previous = {
      ios: { minSupported: '1.0.0', latest: '1.9.0', published: '1.9.0' },
      android: { minSupported: '1.0.0', latest: '1.9.0', published: '1.9.0' },
    };
    const proposed = {
      ios: { minSupported: '1.10.0', latest: '1.10.0', published: '1.10.0' },
      android: { minSupported: '1.10.0', latest: '1.10.0', published: '1.10.0' },
    };
    expect(() =>
      planSetChange({
        key,
        proposedValue: proposed,
        current: snapshot(previous, currentUpdatedAt),
        force: false,
        now: new Date('2026-11-25T12:00:00.000Z'),
      }),
    ).toThrow(AppConfigOperationError);
  });

  it('rejects minSupported above published even when the proposal itself has a later latest version', () => {
    const proposed = {
      ios: { minSupported: '2.3.0', latest: '2.4.0', published: '2.2.0' },
      android: { minSupported: '2.3.0', latest: '2.4.0', published: '2.2.0' },
    };
    expect(() =>
      planSetChange({
        key,
        proposedValue: proposed,
        current: snapshot(currentVersions, currentUpdatedAt),
        force: false,
        now: new Date('2026-11-25T12:00:00.000Z'),
      }),
    ).toThrow(AppConfigOperationError);
  });

  it('still rejects an internally inconsistent version setting with force', () => {
    const invalid = {
      ios: { minSupported: '3.0.0', latest: '2.4.0', published: '3.0.0' },
      android: { minSupported: '1.0.0', latest: '2.4.0', published: '2.4.0' },
    };
    expect(() =>
      planSetChange({
        key,
        proposedValue: invalid,
        current: snapshot(currentVersions, currentUpdatedAt),
        force: true,
        now: new Date('2026-11-25T12:00:00.000Z'),
      }),
    ).toThrow(AppConfigOperationError);
  });

  it('rejects unknown properties on a strict setting schema', () => {
    expect(() =>
      planSetChange({
        key: 'legal',
        proposedValue: {
          termsVersion: '2026-11-25',
          privacyVersion: '2026-11-25',
          unexpected: 'value',
        },
        current: snapshot(null, null),
        force: false,
        now: new Date('2026-11-25T12:00:00.000Z'),
      }),
    ).toThrow(AppConfigOperationError);
  });

  it('requires a future maintenance end time using the injected clock', () => {
    const maintenance = {
      active: true,
      platforms: ['ios'],
      messageKey: 'maintenance.default',
      until: '2026-11-25T11:59:59.000Z',
    };
    expect(() =>
      planSetChange({
        key: 'maintenance',
        proposedValue: maintenance,
        current: snapshot(null, '2026-11-25T11:00:00.000000+00:00'),
        force: false,
        now: new Date('2026-11-25T12:00:00.000Z'),
      }),
    ).toThrow(AppConfigOperationError);
  });

  it('carries forward stored published versions when the proposal omits them', () => {
    const proposed = {
      ios: { minSupported: '2.0.0', latest: '2.3.0' },
      android: { minSupported: '2.0.0', latest: '2.3.0' },
    };
    const plan = planSetChange({
      key,
      proposedValue: proposed,
      current: snapshot(currentVersions, currentUpdatedAt),
      force: false,
      now: new Date('2026-11-25T12:00:00.000Z'),
    });

    expect(plan.after).toEqual({
      ios: { ...currentVersions.ios, minSupported: '2.0.0' },
      android: { ...currentVersions.android, minSupported: '2.0.0' },
    });
  });
});

describe('app-config rollback planning', () => {
  const key: AppConfigKey = 'legal';
  const currentValue = { termsVersion: '2026-11-25', privacyVersion: '2026-11-25' };
  const previousValue = { termsVersion: '2026-11-20', privacyVersion: '2026-11-20' };
  const currentUpdatedAt = '2026-11-25T12:34:56.123456+00:00';
  const source: RollbackSource = {
    eventId: '7c26fdb6-c767-4c99-9263-a375df9a23be',
    key,
    before: previousValue,
    after: currentValue,
  };

  it('plans the previous value with the exact current timestamp as the CAS token', () => {
    const plan = planRollback({
      key,
      current: snapshot(currentValue, currentUpdatedAt),
      source,
    });

    expect(plan.before).toEqual(currentValue);
    expect(plan.after).toEqual(previousValue);
    expect(plan.expectedUpdatedAt).toBe(currentUpdatedAt);
    expect(plan.rollbackEventId).toBe(source.eventId);
  });

  it('rejects a rollback source for another key or an event that no longer matches current state', () => {
    expect(() =>
      planRollback({
        key,
        current: snapshot(currentValue, currentUpdatedAt),
        source: { ...source, key: 'versions' },
      }),
    ).toThrow(AppConfigOperationError);

    expect(() =>
      planRollback({
        key,
        current: snapshot(currentValue, currentUpdatedAt),
        source: { ...source, after: previousValue },
      }),
    ).toThrow(AppConfigOperationError);
  });

  it('rejects a missing CAS timestamp instead of converting it or retrying without one', () => {
    expect(() =>
      planRollback({
        key,
        current: { value: currentValue, updatedAt: null },
        source,
      }),
    ).toThrow(AppConfigOperationError);
  });

  it('plans through key-scoped reader ports without exposing or invoking a writer', async () => {
    const reads: AppConfigKey[] = [];
    const planner = createAppConfigPlanner(
      {
        async readCurrent(readKey) {
          reads.push(readKey);
          return snapshot(currentValue, currentUpdatedAt);
        },
        async readLatestRollbackSource(readKey) {
          reads.push(readKey);
          return source;
        },
      },
      () => new Date('2026-11-25T12:00:00.000Z'),
    );

    const plan = await planner.planRollback(key);

    expect(plan.after).toEqual(previousValue);
    expect(reads).toEqual([key, key]);
  });

  it('sanitizes a reader failure without exposing its message', async () => {
    const planner = createAppConfigPlanner({
      async readCurrent() {
        throw new Error('database URL is private');
      },
      async readLatestRollbackSource() {
        return null;
      },
    });

    await expect(
      planner.planSet({ key, proposedValue: previousValue, force: false }),
    ).rejects.toMatchObject({
      code: 'app_config.read_failed',
      message: 'The current app-config state could not be read.',
    });
  });
});

describe('app-config safe failure mapping', () => {
  it('maps AC409 to the stable conflict response without retaining driver details', () => {
    const failure = toSafeOperationFailure({
      code: 'AC409',
      message: 'contains private connection details',
    });
    expect(failure).toEqual({
      status: 409,
      code: 'app_config.conflict',
      message: 'The app-config value changed; review the current diff before retrying.',
    });
    expect(JSON.stringify(failure)).not.toContain('private connection details');
  });

  it('maps unrecognized failures to a safe stable response', () => {
    expect(toSafeOperationFailure(new Error('database URL is secret'))).toEqual({
      status: 500,
      code: 'app_config.operation_failed',
      message: 'The app-config operation failed.',
    });
  });
});
