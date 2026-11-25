import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import type { AuthorizationPolicy } from '../../authorization/types';
import type {
  AccountDeletionPolicy,
  EntitlementsReader,
  EmailSender,
} from '../../extensions/ports';
import {
  assertAccountDeletionPolicyContract,
  assertAuthorizationPolicyContract,
  assertEmailSenderContract,
  assertEntitlementsFailClosed,
  assertExportIsolation,
  runExportIsolationContracts,
  runRegisteredPortContracts,
  type PortContractSuite,
} from './index';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const request = {
  auth: {
    kind: 'user' as const,
    userId: USER_A,
    isAnonymous: false,
    appRoles: [],
    providers: ['email'],
    amr: [],
  },
  host: 'app.example',
  method: 'GET',
  path: '/v1/test',
  now: new Date('2026-11-24T12:00:00.000Z'),
  async loadFreshRoles() {
    return [];
  },
};

describe('extension port contract suites', () => {
  it('rejects an entitlements reader that returns access after its provider fails', async () => {
    const reader: EntitlementsReader = {
      async read() {
        return {
          entitlements: [
            { key: 'pro', expiresAt: null, willRenew: null, store: 'unknown', isSandbox: null },
          ],
          fetchedAt: new Date(),
        };
      },
    };
    await expect(
      assertEntitlementsFailClosed(() => reader.read(USER_A, { fresh: true })),
    ).rejects.toThrow(/returned access after a provider failure/);
    await expect(
      assertEntitlementsFailClosed(async () => {
        throw new Error('provider unavailable');
      }),
    ).resolves.toBeUndefined();
  });

  it('fails a policy contract when the authorization policy throws', async () => {
    const policy: AuthorizationPolicy = async () => {
      throw new Error('test-only policy error');
    };
    await expect(assertAuthorizationPolicyContract(policy, request)).rejects.toThrow(
      /must return a deny decision/,
    );
  });

  it('requires a contract suite for each overridden port and runs the registered suite', async () => {
    const sender: EmailSender = { async send() {} };
    await expect(runRegisteredPortContracts({ EmailSender: sender }, [])).rejects.toThrow(
      /Missing contract suite/,
    );
    let ran = false;
    const suite: PortContractSuite = {
      port: 'EmailSender',
      async run(port) {
        await assertEmailSenderContract(port, {
          to: 'test-user@example.test',
          subject: 'Test',
          html: '<p>Test</p>',
          text: 'Test',
          idempotencyKey: 'test-email-idempotency-key',
        });
        ran = true;
      },
    };
    await runRegisteredPortContracts({ EmailSender: sender }, [suite]);
    expect(ran).toBe(true);
  });

  it('checks scheduled and cancelled deletion state against getPending', async () => {
    let pending: { readonly scheduledFor: Date } | null = null;
    const scheduledFor = new Date('2026-12-01T00:00:00.000Z');
    const policy: AccountDeletionPolicy = {
      async request() {
        pending = { scheduledFor };
        return { status: 'scheduled', scheduledFor };
      },
      async cancel() {
        pending = null;
        return { status: 'cancelled' };
      },
      async getPending() {
        return pending;
      },
    };
    await expect(
      assertAccountDeletionPolicyContract(policy, {
        userId: USER_A,
        correlationId: '00000000-0000-7000-8000-000000000001',
      }),
    ).resolves.toBeUndefined();
  });

  it('fails when an export section has no isolation contract or returns cross-user markers', async () => {
    await expect(runExportIsolationContracts(['profile'], [])).rejects.toThrow(
      /Missing export isolation contract/,
    );
    const schema = z.strictObject({ value: z.string() });
    const suite = {
      sectionName: 'profile',
      run: () =>
        assertExportIsolation({
          schema,
          userA: USER_A,
          userB: USER_B,
          userAMarkers: ['only-user-a'],
          userBMarkers: ['only-user-b'],
          async collect(userId) {
            return { value: userId === USER_A ? 'only-user-b' : 'only-user-b' };
          },
        }),
    };
    await expect(runExportIsolationContracts(['profile'], [suite])).rejects.toThrow(/user B/);
  });
});
