import { describe, expect, it } from 'vitest';

import { createAppConfigSettingsReader } from './settings-reader';

const ROWS = [
  {
    key: 'versions',
    value: {
      ios: { minSupported: '1.0.0', latest: '1.1.0' },
      android: { minSupported: '2.0.0', latest: '2.1.0' },
    },
  },
  { key: 'maintenance', value: { active: false } },
  { key: 'legal', value: { termsVersion: '2026-01-01', privacyVersion: '2026-01-02' } },
];

function createDatabase(rows: readonly unknown[]) {
  const calls: unknown[][] = [];
  const transaction = {
    selectFrom(table: string) {
      calls.push(['table', table]);
      return {
        select(columns: readonly string[]) {
          calls.push(['columns', ...columns]);
          return {
            where(column: string, operator: string, keys: readonly string[]) {
              calls.push(['where', column, operator, ...keys]);
              return {
                async execute() {
                  return rows;
                },
              };
            },
          };
        },
      };
    },
  };
  const database = {
    async systemDb(context: string, work: (transaction: never) => Promise<unknown>) {
      calls.push(['context', context]);
      return work(transaction as never);
    },
  };
  return { database: database as never, calls };
}

describe('app-config setting reader', () => {
  it('reads only the supported rows with the dedicated system role and normalizes valid values', async () => {
    const { database, calls } = createDatabase(ROWS);
    const result = await createAppConfigSettingsReader(database).readAll();

    expect(result).toEqual({
      settings: {
        versions: {
          ios: { minSupported: '1.0.0', latest: '1.1.0' },
          android: { minSupported: '2.0.0', latest: '2.1.0' },
        },
        maintenance: {
          active: false,
          platforms: ['ios', 'android'],
          messageKey: 'maintenance.default',
          until: null,
        },
        legal: { termsVersion: '2026-01-01', privacyVersion: '2026-01-02' },
      },
      invalidKeys: [],
    });
    expect(calls).toEqual([
      ['context', 'app-config'],
      ['table', 'app_config.settings'],
      ['columns', 'key', 'value'],
      ['where', 'key', 'in', 'versions', 'maintenance', 'legal'],
    ]);
  });

  it('isolates malformed, duplicate, and missing settings by key', async () => {
    const { database } = createDatabase([
      { key: 'versions', value: { ios: { minSupported: '3.0.0', latest: '2.0.0' } } },
      {
        key: 'maintenance',
        value: { active: true, messageKey: 'invalid value', extra: 'ignored' },
      },
      { key: 'legal', value: { termsVersion: '2025-02-29', privacyVersion: '2026-01-01' } },
      { key: 'legal', value: { termsVersion: '2026-01-01', privacyVersion: '2026-01-02' } },
      { key: 'unknown', value: { secret: 'must not be returned' } },
    ]);

    await expect(createAppConfigSettingsReader(database).readAll()).resolves.toEqual({
      settings: {},
      invalidKeys: ['versions', 'maintenance', 'legal'],
    });
  });

  it('rejects store and legal URLs from persisted settings', async () => {
    const { database } = createDatabase([
      {
        key: 'versions',
        value: {
          ios: { minSupported: '1.0.0', latest: '1.1.0', storeUrl: 'https://evil.invalid' },
          android: { minSupported: '1.0.0', latest: '1.1.0' },
        },
      },
      { key: 'maintenance', value: { active: false } },
      {
        key: 'legal',
        value: {
          termsVersion: '2026-01-01',
          privacyVersion: '2026-01-02',
          termsUrl: 'https://evil.invalid',
        },
      },
    ]);

    await expect(createAppConfigSettingsReader(database).readAll()).resolves.toEqual({
      settings: {
        maintenance: {
          active: false,
          platforms: ['ios', 'android'],
          messageKey: 'maintenance.default',
          until: null,
        },
      },
      invalidKeys: ['versions', 'legal'],
    });
  });

  it('reports an absent row as invalid while preserving other valid settings', async () => {
    const { database } = createDatabase(ROWS.filter((row) => row.key !== 'legal'));

    await expect(createAppConfigSettingsReader(database).readAll()).resolves.toMatchObject({
      settings: {
        versions: { ios: { minSupported: '1.0.0' } },
        maintenance: { active: false },
      },
      invalidKeys: ['legal'],
    });
  });
});
