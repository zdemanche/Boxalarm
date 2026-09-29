import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { buildOutboxRecord } from '@boxalarm/outbox';
import { isConditionFailureAt } from './repository.js';
import { LAST_PAYLOAD_SK } from './submissionRepository.js';
import type { IncidentStatus } from './entity.js';

/**
 * Officer review lock, admin unlock and NERIS resubmission — each one transaction that
 * commits the METADATA change, a durable AUDIT_LOG_ENTRY (createIncident's shape) and its
 * outbox events together.
 */

/** Submission statuses that mean the worker may be reading the record right now. */
const IN_FLIGHT = ['SUBMITTED', 'RETRYING'] as const;
const NOT_IN_FLIGHT =
  'attribute_not_exists(submissionStatus) OR (submissionStatus <> :queued AND submissionStatus <> :retrying)';

export type ReviewConflict =
  | 'NOT_FOUND'
  | 'ALREADY_LOCKED'
  | 'NOT_LOCKED'
  | 'CHANGED_SINCE_REVIEW'
  | 'SUBMISSION_IN_FLIGHT'
  | 'NOT_IN_NERIS';

export class ReviewConflictError extends Error {
  constructor(readonly conflict: ReviewConflict) {
    super(conflict);
    this.name = 'ReviewConflictError';
  }
}

function metadataKey(deptId: VerifiedDeptId, incidentId: string) {
  return { pk: buildDeptScopedPk(deptId, 'INCIDENT', incidentId), sk: 'METADATA' };
}

function auditItem(
  deptId: VerifiedDeptId,
  incidentId: string,
  actorId: string,
  action: string,
  changedFields: Record<string, { old: unknown; new: unknown }>,
  extra: Record<string, unknown> = {},
) {
  const ts = Date.now();
  return {
    pk: buildDeptScopedPk(deptId, 'AUDIT', new Date(ts).toISOString().slice(0, 10)),
    sk: `${ts}#INCIDENT#${incidentId}#${actorId}`,
    entityType: 'AUDIT_LOG_ENTRY',
    mutatedEntityType: 'INCIDENT',
    mutatedEntityId: incidentId,
    action,
    actorId,
    changedFields,
    ts,
    gsi3pk: buildDeptScopedPk(deptId, 'AUDIT', 'ENTITY', 'INCIDENT', incidentId),
    gsi3sk: String(ts),
    ...extra,
  };
}

async function readMetadata(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  incidentId: string,
): Promise<Record<string, unknown> | undefined> {
  const result = await client.send(
    new GetCommand({
      TableName: tableName,
      Key: metadataKey(deptId, incidentId),
      ConsistentRead: true,
    }),
  );
  return result.Item as Record<string, unknown> | undefined;
}

function inFlight(item: Record<string, unknown>): boolean {
  return (IN_FLIGHT as readonly unknown[]).includes(item.submissionStatus);
}

export interface LockInput {
  readonly deptId: VerifiedDeptId;
  readonly incidentId: string;
  readonly actorId: string;
  /** The row's updatedAt when it was validated: a change since then fails the lock. */
  readonly reviewedUpdatedAt: number;
  readonly previousStatus: IncidentStatus;
  /** Queue the NERIS submission in the same transaction (department autoSubmitOnLock). */
  readonly submit: boolean;
  readonly nowEpochSeconds: number;
  readonly traceId: string;
}

export async function lockIncident(
  client: DynamoDBDocumentClient,
  tableName: string,
  input: LockInput,
): Promise<{ status: IncidentStatus; submissionStatus?: 'SUBMITTED' }> {
  const status: IncidentStatus = input.submit ? 'SUBMITTED' : 'VALIDATED';
  const outbox = [
    buildOutboxRecord(input.deptId, 'incident-service', 'incident.report.locked', input.traceId, {
      incidentId: input.incidentId,
      deptId: input.deptId,
      lockedBy: input.actorId,
      lockedAt: input.nowEpochSeconds,
      autoSubmitted: input.submit,
    }),
    ...(input.submit
      ? [
          buildOutboxRecord(
            input.deptId,
            'incident-service',
            'neris.incident.submitted',
            input.traceId,
            { incidentId: input.incidentId, deptId: input.deptId, submissionStatus: 'SUBMITTED' },
          ),
        ]
      : []),
  ];
  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tableName,
              Key: metadataKey(input.deptId, input.incidentId),
              ConditionExpression:
                'attribute_exists(pk) AND attribute_not_exists(lockedAt) AND updatedAt = :reviewed',
              // updatedAt is left alone: it marks content edits, which the ledger's
              // editedSinceSubmission compares against lastSubmittedAt; lock/unlock are not edits.
              UpdateExpression: `SET lockedAt = :now, lockedBy = :actor, #status = :status${
                input.submit ? ', submissionStatus = :queued REMOVE submissionFailureReason' : ''
              }`,
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':now': input.nowEpochSeconds,
                ':actor': input.actorId,
                ':reviewed': input.reviewedUpdatedAt,
                ':status': status,
                ...(input.submit ? { ':queued': 'SUBMITTED' } : {}),
              },
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: auditItem(input.deptId, input.incidentId, input.actorId, 'LOCK', {
                status: { old: input.previousStatus, new: status },
                lockedAt: { old: null, new: input.nowEpochSeconds },
              }),
            },
          },
          ...outbox.map((Item) => ({ Put: { TableName: tableName, Item } })),
        ],
      }),
    );
  } catch (error) {
    if (isConditionFailureAt(error, 0)) {
      const item = await readMetadata(client, tableName, input.deptId, input.incidentId);
      throw new ReviewConflictError(
        !item
          ? 'NOT_FOUND'
          : typeof item.lockedAt === 'number'
            ? 'ALREADY_LOCKED'
            : 'CHANGED_SINCE_REVIEW',
      );
    }
    throw error;
  }
  return { status, ...(input.submit ? { submissionStatus: 'SUBMITTED' as const } : {}) };
}

export interface UnlockInput {
  readonly deptId: VerifiedDeptId;
  readonly incidentId: string;
  readonly actorId: string;
  readonly reason: string;
  readonly nowEpochSeconds: number;
  readonly traceId: string;
}

export async function unlockIncident(
  client: DynamoDBDocumentClient,
  tableName: string,
  input: UnlockInput,
): Promise<void> {
  const before = await readMetadata(client, tableName, input.deptId, input.incidentId);
  if (!before) throw new ReviewConflictError('NOT_FOUND');
  if (typeof before.lockedAt !== 'number') throw new ReviewConflictError('NOT_LOCKED');
  if (inFlight(before)) throw new ReviewConflictError('SUBMISSION_IN_FLIGHT');
  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tableName,
              Key: metadataKey(input.deptId, input.incidentId),
              ConditionExpression: `attribute_exists(pk) AND attribute_exists(lockedAt) AND (${NOT_IN_FLIGHT})`,
              UpdateExpression:
                'REMOVE lockedAt, lockedBy SET unlockedAt = :now, unlockedBy = :actor, lastUnlockReason = :reason',
              ExpressionAttributeValues: {
                ':now': input.nowEpochSeconds,
                ':actor': input.actorId,
                ':reason': input.reason,
                ':queued': 'SUBMITTED',
                ':retrying': 'RETRYING',
              },
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: auditItem(
                input.deptId,
                input.incidentId,
                input.actorId,
                'UNLOCK',
                { lockedAt: { old: before.lockedAt, new: null } },
                { reason: input.reason },
              ),
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: buildOutboxRecord(
                input.deptId,
                'incident-service',
                'incident.report.unlocked',
                input.traceId,
                {
                  incidentId: input.incidentId,
                  deptId: input.deptId,
                  unlockedBy: input.actorId,
                  reason: input.reason,
                },
              ),
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (isConditionFailureAt(error, 0)) {
      const item = await readMetadata(client, tableName, input.deptId, input.incidentId);
      throw new ReviewConflictError(
        !item
          ? 'NOT_FOUND'
          : typeof item.lockedAt !== 'number'
            ? 'NOT_LOCKED'
            : 'SUBMISSION_IN_FLIGHT',
      );
    }
    throw error;
  }
}

export interface ResubmitInput {
  readonly deptId: VerifiedDeptId;
  readonly incidentId: string;
  readonly actorId: string;
  readonly changeCount: number;
  readonly nowEpochSeconds: number;
  readonly traceId: string;
}

/** Queues a PUT-by-NERIS-id of a locked report that NERIS already holds. */
export async function enqueueResubmission(
  client: DynamoDBDocumentClient,
  tableName: string,
  input: ResubmitInput,
): Promise<void> {
  const payload = { incidentId: input.incidentId, deptId: input.deptId };
  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tableName,
              Key: metadataKey(input.deptId, input.incidentId),
              ConditionExpression: `attribute_exists(lockedAt) AND attribute_exists(nerisIncidentId) AND (${NOT_IN_FLIGHT})`,
              UpdateExpression:
                'SET #status = :queued, submissionStatus = :queued, updatedAt = :now REMOVE submissionFailureReason',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':queued': 'SUBMITTED',
                ':retrying': 'RETRYING',
                ':now': input.nowEpochSeconds,
              },
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: buildOutboxRecord(
                input.deptId,
                'incident-service',
                'neris.incident.submitted',
                input.traceId,
                { ...payload, submissionStatus: 'SUBMITTED' },
              ),
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: buildOutboxRecord(
                input.deptId,
                'incident-service',
                'neris.incident.resubmitted',
                input.traceId,
                { ...payload, requestedBy: input.actorId, changeCount: input.changeCount },
              ),
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (isConditionFailureAt(error, 0)) {
      const item = await readMetadata(client, tableName, input.deptId, input.incidentId);
      throw new ReviewConflictError(
        !item
          ? 'NOT_FOUND'
          : typeof item.lockedAt !== 'number'
            ? 'NOT_LOCKED'
            : typeof item.nerisIncidentId !== 'string'
              ? 'NOT_IN_NERIS'
              : 'SUBMISSION_IN_FLIGHT',
      );
    }
    throw error;
  }
}

export async function getLastAcceptedPayload(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  incidentId: string,
): Promise<Record<string, unknown> | undefined> {
  const result = await client.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: buildDeptScopedPk(deptId, 'INCIDENT', incidentId), sk: LAST_PAYLOAD_SK },
    }),
  );
  const payload = (result.Item as { payload?: unknown } | undefined)?.payload;
  return typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)
    : undefined;
}

export interface LedgerAttempt {
  readonly attempt: number;
  readonly attemptedAt: string;
  readonly outcome: string;
  readonly httpStatus: number;
  readonly retryCount: number;
  readonly operation?: string;
  readonly nerisIncidentId?: string;
  readonly nerisStatus?: string;
  readonly payloadHash?: string;
  readonly failureReason?: string;
  readonly errors: readonly { path: string; code: string; message: string }[];
}

export interface LedgerStatusEntry {
  readonly status: string;
  readonly at: string;
  readonly current: boolean;
}

/** Every NERIS attempt and every NERIS status the poller has seen, oldest first. */
export async function querySubmissionLedger(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  incidentId: string,
): Promise<{ attempts: LedgerAttempt[]; statusHistory: LedgerStatusEntry[] }> {
  const query = async (prefix: string) => {
    const items: Record<string, unknown>[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page = await client.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
          ExpressionAttributeValues: {
            ':pk': buildDeptScopedPk(deptId, 'INCIDENT', incidentId),
            ':prefix': prefix,
          },
          ExclusiveStartKey: start,
        }),
      );
      items.push(...((page.Items ?? []) as Record<string, unknown>[]));
      start = page.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (start);
    return items;
  };
  const [attemptItems, statusItems] = await Promise.all([
    query('SUBMISSION#'),
    query('NERIS#STATUS#'),
  ]);
  const str = (value: unknown) => (typeof value === 'string' ? value : undefined);
  const attempts = attemptItems.map((item, index) => {
    const optional = {
      operation: str(item.operation),
      nerisIncidentId: str(item.nerisIncidentId),
      nerisStatus: str(item.nerisStatus),
      payloadHash: str(item.payloadHash),
      failureReason: str(item.failureReason),
    };
    return {
      attempt: index + 1,
      attemptedAt: str(item.attemptedAt) ?? '',
      outcome: str(item.outcome) ?? 'UNKNOWN',
      httpStatus: typeof item.httpStatus === 'number' ? item.httpStatus : 0,
      retryCount: typeof item.retryCount === 'number' ? item.retryCount : 0,
      ...Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined)),
      errors: Array.isArray(item.errors) ? (item.errors as LedgerAttempt['errors'][number][]) : [],
    };
  });
  const statusHistory = statusItems.map((item) => ({
    status: str(item.status) ?? 'UNKNOWN',
    at: str(item.at) ?? '',
    current: item.current === true,
  }));
  return { attempts, statusHistory };
}
