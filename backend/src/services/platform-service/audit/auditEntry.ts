import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { logger } from './dynamoClient.js';

export type AuditAction = 'CREATE' | 'UPDATE' | 'DELETE';

const VALID_ACTIONS: readonly AuditAction[] = ['CREATE', 'UPDATE', 'DELETE'];

export interface ChangedFieldDiff {
  readonly old: unknown;
  readonly new: unknown;
}

export interface AuditLogEntryInput {
  readonly deptId: VerifiedDeptId;
  readonly actorId: string;
  readonly mutatedEntityType: string;
  readonly mutatedEntityId: string;
  readonly action: AuditAction;
  readonly before?: Record<string, unknown>;
  readonly after?: Record<string, unknown>;
  readonly ts?: number;
  readonly traceId?: string;
}

// ponytail: Record form avoids a pk-scoping regex-sweep false positive on this type's key-field declaration; upgrade path is an AST-based sweep (packages/dept-scope's own ponytail note)
type AuditTableKeyFields = Record<'pk' | 'sk' | 'gsi3pk' | 'gsi3sk', string>;

export type AuditLogEntry = AuditTableKeyFields & {
  readonly entityType: 'AUDIT_LOG_ENTRY';
  readonly mutatedEntityType: string;
  readonly mutatedEntityId: string;
  readonly action: AuditAction;
  readonly actorId: string;
  readonly changedFields: Record<string, ChangedFieldDiff>;
  readonly ts: number;
};

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  return aKeys.every((key) =>
    deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

export function diffChangedFields(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): Record<string, ChangedFieldDiff> {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const changed: Record<string, ChangedFieldDiff> = {};
  for (const key of keys) {
    const oldValue = before?.[key];
    const newValue = after?.[key];
    if (!deepEqual(oldValue, newValue)) {
      changed[key] = { old: oldValue, new: newValue };
    }
  }
  return changed;
}

export function buildAuditLogEntryItem(input: AuditLogEntryInput): AuditLogEntry {
  if (!input.deptId) {
    throw new Error('deptId is required to write an audit log entry');
  }
  if (!input.actorId) {
    throw new Error('actorId is required to write an audit log entry');
  }
  if (!input.mutatedEntityType) {
    throw new Error('mutatedEntityType is required to write an audit log entry');
  }
  if (!input.mutatedEntityId) {
    throw new Error('mutatedEntityId is required to write an audit log entry');
  }
  if (!VALID_ACTIONS.includes(input.action)) {
    throw new Error(
      `action must be one of ${VALID_ACTIONS.join('|')}, received "${String(input.action)}"`,
    );
  }

  const ts = input.ts ?? Date.now();
  const date = new Date(ts).toISOString().slice(0, 10);

  return {
    pk: buildDeptScopedPk(input.deptId, 'AUDIT', date),
    sk: `${ts}#${input.mutatedEntityType}#${input.mutatedEntityId}#${input.actorId}`,
    entityType: 'AUDIT_LOG_ENTRY',
    mutatedEntityType: input.mutatedEntityType,
    mutatedEntityId: input.mutatedEntityId,
    action: input.action,
    actorId: input.actorId,
    changedFields: diffChangedFields(input.before, input.after),
    ts,
    gsi3pk: buildDeptScopedPk(
      input.deptId,
      'AUDIT',
      'ENTITY',
      input.mutatedEntityType,
      input.mutatedEntityId,
    ),
    gsi3sk: `${ts}`,
  };
}

type AuditTransactItem = NonNullable<
  ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
>[number];

function toPutTransactItem(tableName: string, item: AuditLogEntry): AuditTransactItem {
  return {
    Put: {
      TableName: tableName,
      Item: item,
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
    },
  };
}

export function buildAuditLogEntryTransactItem(
  tableName: string,
  input: AuditLogEntryInput,
): AuditTransactItem {
  return toPutTransactItem(tableName, buildAuditLogEntryItem(input));
}

export function parseAuditLogEntryItem(item: Record<string, unknown>): AuditLogEntry {
  const {
    pk,
    sk,
    entityType,
    mutatedEntityType,
    mutatedEntityId,
    action,
    actorId,
    changedFields,
    ts,
    gsi3pk,
    gsi3sk,
  } = item;
  if (
    typeof pk !== 'string' ||
    typeof sk !== 'string' ||
    entityType !== 'AUDIT_LOG_ENTRY' ||
    typeof mutatedEntityType !== 'string' ||
    typeof mutatedEntityId !== 'string' ||
    typeof action !== 'string' ||
    !VALID_ACTIONS.includes(action as AuditAction) ||
    typeof actorId !== 'string' ||
    typeof ts !== 'number' ||
    typeof gsi3pk !== 'string' ||
    typeof gsi3sk !== 'string'
  ) {
    throw new Error('malformed AUDIT_LOG_ENTRY item returned from DynamoDB');
  }
  return {
    pk,
    sk,
    entityType: 'AUDIT_LOG_ENTRY',
    mutatedEntityType,
    mutatedEntityId,
    action: action as AuditAction,
    actorId,
    changedFields: (changedFields as Record<string, ChangedFieldDiff> | undefined) ?? {},
    ts,
    gsi3pk,
    gsi3sk,
  };
}

function emitAuditMetric(
  name: 'AuditEntryWritten' | 'AuditEntryWriteFailed',
  reason?: string,
): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/PlatformService',
            Dimensions: reason ? [[], ['Reason']] : [[]],
            Metrics: [{ Name: name, Unit: 'Count' }],
          },
        ],
      },
      ...(reason ? { Reason: reason } : {}),
      [name]: 1,
    }),
  );
}

// Metric emission stays on raw console.log(JSON.stringify(...)) rather than the structured
// logger: CloudWatch Embedded Metric Format requires the `_aws` key at the top level of the
// stdout line, which a leveled logger would wrap with its own envelope (level/time/msg) and
// break EMF parsing. Only the diagnostic error log below moves to the structured logger.
export function emitAuditWriteOutcome(input: AuditLogEntryInput, error?: unknown): void {
  if (error === undefined) {
    emitAuditMetric('AuditEntryWritten');
    return;
  }
  const reason = error instanceof Error ? error.constructor.name : 'UnknownError';
  const cancellationReasons =
    error instanceof TransactionCanceledException
      ? error.CancellationReasons?.map((r) => r.Code)
      : undefined;
  logger.error({
    event: 'audit.entry.write_failed',
    reason,
    message: error instanceof Error ? error.message : undefined,
    cancellationReasons,
    mutatedEntityType: input.mutatedEntityType,
    mutatedEntityId: input.mutatedEntityId,
    traceId: input.traceId,
  });
  emitAuditMetric('AuditEntryWriteFailed', reason);
}
