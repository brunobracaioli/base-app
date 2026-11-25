import { createHmac } from 'node:crypto';
import * as z from 'zod';

import { parseServerEnv, requireAuditSubjectKey } from '../env/index';
import { UUID_PATTERN } from '../http/request-id';
import { redactText } from '../observability/redaction';
import type { AuditEvent, AuditEventRow, AuditEventTransaction } from './types';

const referencePattern = new RegExp(
  `^(?:${UUID_PATTERN.source.slice(1, -1)}|script:[a-z0-9:_-]{1,96}|[0-9a-f]{64})$`,
);
const subjectReferencePattern = new RegExp(
  `^(?:${UUID_PATTERN.source.slice(1, -1)}|[0-9a-f]{64})$`,
);
const resourceUuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const privateMetadataKey =
  /email|token|password|name|body|message|authorization|cookie|code|signature|phone|address|cpf/i;

const metadataValueSchema = z.union([z.string().max(256), z.number(), z.boolean(), z.null()]);

export const AuditEventInput = z
  .strictObject({
    actorType: z.enum(['user', 'system', 'webhook', 'operator']),
    actorRef: z.string().max(128).nullable(),
    subjectRef: z.string().max(128).nullable(),
    action: z.string().regex(/^[a-z_]+(?:\.[a-z_]+)+$/),
    resourceType: z.string().max(64),
    resourceRef: z.string().max(128).nullable(),
    outcome: z.enum(['success', 'denied', 'failed']),
    correlationId: z.uuid(),
    metadata: z.record(z.string(), metadataValueSchema),
  })
  .superRefine((event, context) => {
    if (event.actorRef !== null && !referencePattern.test(event.actorRef)) {
      context.addIssue({ code: 'custom', path: ['actorRef'], message: 'Invalid actor reference.' });
    }
    if (event.subjectRef !== null && !subjectReferencePattern.test(event.subjectRef)) {
      context.addIssue({
        code: 'custom',
        path: ['subjectRef'],
        message: 'Invalid subject reference.',
      });
    }
    if (event.resourceRef !== null && resourceUuidPattern.test(event.resourceRef)) {
      context.addIssue({
        code: 'custom',
        path: ['resourceRef'],
        message: 'Resource reference cannot contain a user UUID.',
      });
    }
    for (const [key, value] of Object.entries(event.metadata)) {
      if (privateMetadataKey.test(key)) {
        context.addIssue({
          code: 'custom',
          path: ['metadata', key],
          message: 'Metadata key may contain personal data.',
        });
      }
      if (typeof value === 'string' && redactText(value) !== value) {
        context.addIssue({
          code: 'custom',
          path: ['metadata', key],
          message: 'Metadata value may contain personal data.',
        });
      }
    }
    const metadataBytes = Buffer.byteLength(JSON.stringify(event.metadata), 'utf8');
    if (metadataBytes > 4_096) {
      context.addIssue({
        code: 'custom',
        path: ['metadata'],
        message: 'Audit metadata exceeds 4096 bytes.',
      });
    }
  });

export async function recordAuditEvent(
  db: AuditEventTransaction,
  event: AuditEvent,
): Promise<void> {
  const parsed = AuditEventInput.parse(event);
  const row: AuditEventRow = {
    actor_type: parsed.actorType,
    actor_ref: parsed.actorRef,
    subject_ref: parsed.subjectRef,
    action: parsed.action,
    resource_type: parsed.resourceType,
    resource_ref: parsed.resourceRef,
    outcome: parsed.outcome,
    correlation_id: parsed.correlationId,
    metadata: parsed.metadata,
  };
  await db.insertInto('audit.events').values(row).execute();
}

export function subjectRef(userId: string): string;
export function subjectRef(userId: string, key: string): string;
export function subjectRef(userId: string, injectedKey?: string): string {
  if (!UUID_PATTERN.test(userId)) throw new TypeError('userId must be a UUID.');
  const key = injectedKey ?? requireAuditSubjectKey(parseServerEnv());
  if (Buffer.byteLength(key, 'utf8') < 32)
    throw new TypeError('AUDIT_SUBJECT_KEY must contain at least 32 bytes.');
  return createHmac('sha256', key).update(userId, 'utf8').digest('hex');
}

export type { AuditEvent, AuditEventTransaction } from './types';
