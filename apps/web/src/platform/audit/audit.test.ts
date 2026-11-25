import { describe, expect, it } from 'vitest';

import { recordAuditEvent, subjectRef } from './index';
import type { AuditEventRow, AuditEventTransaction } from './types';

const USER_A = '11111111-1111-4111-8111-111111111111';
const CORRELATION_ID = '00000000-0000-7000-8000-000000000001';

class FakeAuditTransaction implements AuditEventTransaction {
  readonly rows: AuditEventRow[] = [];
  failure: Error | undefined;

  insertInto(table: 'audit.events') {
    if (table !== 'audit.events') throw new Error('Unexpected audit table.');
    return {
      values: (row: AuditEventRow) => ({
        execute: async (): Promise<unknown> => {
          if (this.failure) throw this.failure;
          this.rows.push(row);
          return {};
        },
      }),
    };
  }
}

function validEvent() {
  return {
    actorType: 'user' as const,
    actorRef: USER_A,
    subjectRef: USER_A,
    action: 'profile.updated',
    resourceType: 'identity.profile',
    resourceRef: 'profile',
    outcome: 'success' as const,
    correlationId: CORRELATION_ID,
    metadata: { source: 'mobile' },
  };
}

describe('audit event writer', () => {
  it('validates and maps an event into the caller transaction', async () => {
    const transaction = new FakeAuditTransaction();
    await recordAuditEvent(transaction, validEvent());
    expect(transaction.rows).toEqual([
      {
        actor_type: 'user',
        actor_ref: USER_A,
        subject_ref: USER_A,
        action: 'profile.updated',
        resource_type: 'identity.profile',
        resource_ref: 'profile',
        outcome: 'success',
        correlation_id: CORRELATION_ID,
        metadata: { source: 'mobile' },
      },
    ]);
  });

  it('rejects PII metadata keys and values before insert', async () => {
    const transaction = new FakeAuditTransaction();
    await expect(
      recordAuditEvent(transaction, { ...validEvent(), metadata: { email: 'user@example.test' } }),
    ).rejects.toThrow();
    await expect(
      recordAuditEvent(transaction, { ...validEvent(), metadata: { note: 'user@example.test' } }),
    ).rejects.toThrow();
    expect(transaction.rows).toHaveLength(0);
  });

  it('fails closed when the caller transaction insert fails', async () => {
    const transaction = new FakeAuditTransaction();
    const driverError = new Error('database diagnostic must not reach the client');
    transaction.failure = driverError;
    await expect(recordAuditEvent(transaction, validEvent())).rejects.toBe(driverError);
  });

  it('computes stable, user-specific subject references', () => {
    const generatedTestKey = 'test-only-key-never-used-outside-this-test-0001';
    expect(subjectRef(USER_A, generatedTestKey)).toBe(subjectRef(USER_A, generatedTestKey));
    expect(subjectRef(USER_A, generatedTestKey)).not.toBe(
      subjectRef('22222222-2222-4222-8222-222222222222', generatedTestKey),
    );
    expect(() => subjectRef(USER_A, 'short')).toThrow();
  });
});
