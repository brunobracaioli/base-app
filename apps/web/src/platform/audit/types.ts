export type AuditEventActorType = 'user' | 'system' | 'webhook' | 'operator';
export type AuditEventOutcome = 'success' | 'denied' | 'failed';

export type AuditEvent = {
  readonly actorType: AuditEventActorType;
  readonly actorRef: string | null;
  readonly subjectRef: string | null;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceRef: string | null;
  readonly outcome: AuditEventOutcome;
  readonly correlationId: string;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
};

export type AuditEventRow = {
  readonly actor_type: AuditEventActorType;
  readonly actor_ref: string | null;
  readonly subject_ref: string | null;
  readonly action: string;
  readonly resource_type: string;
  readonly resource_ref: string | null;
  readonly outcome: AuditEventOutcome;
  readonly correlation_id: string;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
};

export interface AuditEventInsertQuery {
  values(row: AuditEventRow): { execute(): Promise<unknown> };
}

/** Narrow Kysely transaction surface; the caller keeps its own role and transaction. */
export interface AuditEventTransaction {
  insertInto(table: 'audit.events'): AuditEventInsertQuery;
}
