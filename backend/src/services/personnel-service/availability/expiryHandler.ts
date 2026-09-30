import { randomUUID } from 'node:crypto';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { createDdbClient, parseMarkoffItem, readPersonnelDdbConfig } from './dynamoClient.js';

const METRIC_NAMESPACE = 'Boxalarm/personnel-availability';
/** A revert that loses a race to an ACTIVATE re-reads and tries again (MAJOR-R2-1). */
const MAX_REVERT_ATTEMPTS = 3;

export type TransitionAction = 'ACTIVATE' | 'REVERT';

export interface ExpirySchedulePayload {
  readonly deptId: string;
  readonly memberId: string;
  readonly startAt: number;
  readonly action?: TransitionAction;
}

interface TransactCancellationError {
  readonly name: string;
  readonly CancellationReasons?: ReadonlyArray<{ readonly Code?: string }>;
}

function asTransactionCancellation(error: unknown): TransactCancellationError | undefined {
  return error instanceof Error && error.name === 'TransactionCanceledException'
    ? error
    : undefined;
}

export type ExpiryOutcome =
  | 'REVERTED'
  | 'ACTIVATED'
  | 'SKIPPED_ALREADY_REVERTED'
  | 'SKIPPED_ALREADY_ACTIVATED'
  | 'SKIPPED_NOT_FOUND';

function isExpirySchedulePayload(value: unknown): value is ExpirySchedulePayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.deptId === 'string' &&
    typeof candidate.memberId === 'string' &&
    typeof candidate.startAt === 'number' &&
    (candidate.action === undefined ||
      candidate.action === 'ACTIVATE' ||
      candidate.action === 'REVERT')
  );
}

function logError(
  event: string,
  error: unknown,
  correlationId: string,
  extra: Record<string, unknown> = {},
): void {
  console.error(
    JSON.stringify({
      event,
      service: 'personnel-service',
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      message: error instanceof Error ? error.message : undefined,
      correlationId,
      ...extra,
    }),
  );
}

export const handler = async (payload: unknown): Promise<{ outcome: ExpiryOutcome }> => {
  if (!isExpirySchedulePayload(payload)) {
    const error = new Error('expiry schedule payload failed shape validation');
    logError('availability.expiry.malformed_payload', error, 'unknown');
    throw error;
  }

  const { memberId, startAt } = payload;
  const action: TransitionAction = payload.action ?? 'REVERT';
  const deptId = toVerifiedDeptId({ deptId: payload.deptId });
  const correlationId = `${deptId}#${memberId}#${startAt}#${action}`;
  const { tableName } = readPersonnelDdbConfig(process.env);
  const ddb = createDdbClient(process.env);
  const pk = buildDeptScopedPk(deptId, 'MEMBER', memberId);
  const sk = `MARKOFF#${startAt}`;

  let markoff;
  try {
    const result = await ddb.send(new GetCommand({ TableName: tableName, Key: { pk, sk } }));
    markoff = parseMarkoffItem(result.Item);
  } catch (error) {
    logError('availability.expiry.read_failed', error, correlationId);
    throw error;
  }

  if (!markoff) {
    return { outcome: 'SKIPPED_NOT_FOUND' };
  }
  if (markoff.revertedAt !== undefined) {
    return { outcome: 'SKIPPED_ALREADY_REVERTED' };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const eventTime = new Date().toISOString();
  const eventId = randomUUID();

  if (action === 'ACTIVATE') {
    if (markoff.activatedAt !== undefined) {
      return { outcome: 'SKIPPED_ALREADY_ACTIVATED' };
    }

    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: tableName,
                Key: { pk, sk },
                UpdateExpression: 'SET activatedAt = :now',
                ConditionExpression:
                  'attribute_exists(sk) AND attribute_not_exists(activatedAt) AND attribute_not_exists(revertedAt)',
                ExpressionAttributeValues: { ':now': nowSeconds },
              },
            },
            {
              Put: {
                TableName: tableName,
                Item: {
                  pk: buildDeptScopedPk(deptId, 'OUTBOX', 'MEMBER', memberId),
                  sk: `EVT#${eventId}`,
                  entityType: 'OUTBOX_ENTRY',
                  eventId,
                  eventType: 'personnel.availability.changed',
                  correlationId: memberId,
                  // The platform drain publishes only rows carrying the full envelope
                  // (eventTime, source, schemaVersion); without them it drops the row silently.
                  eventTime,
                  source: 'personnel-service',
                  schemaVersion: '1.0',
                  createdAt: nowSeconds,
                  payload: {
                    deptId,
                    memberId,
                    availabilityState: 'MARKED_OFF',
                    startAt,
                    endAt: markoff.endAt,
                  },
                },
              },
            },
          ],
        }),
      );
    } catch (error) {
      const cancellation = asTransactionCancellation(error);
      if (cancellation) {
        if (cancellation.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed') {
          return { outcome: 'SKIPPED_ALREADY_ACTIVATED' };
        }
        logError('availability.expiry.write_failed', error, correlationId, {
          cancellationReasons: cancellation.CancellationReasons?.map((r) => r.Code),
        });
        emitOutcomeMetric(METRIC_NAMESPACE, 'ExpiryFailed', 'DynamoDbUnavailable');
        throw error;
      }
      logError('availability.expiry.write_failed', error, correlationId);
      emitOutcomeMetric(METRIC_NAMESPACE, 'ExpiryFailed', 'DynamoDbUnavailable');
      throw error;
    }

    emitOutcomeMetric(METRIC_NAMESPACE, 'MarkoffActivated');
    return { outcome: 'ACTIVATED' };
  }

  // Paging review MAJOR-R2-1 (same race as ending early): an ACTIVATE committing between this
  // read and the write would stamp MARKED_OFF later than an AVAILABLE stamped at handler start,
  // leaving the member marked off. The revert is conditioned on the activatedAt state read, and
  // its AVAILABLE eventTime is at least a second after activatedAt; a lost race re-reads.
  for (let attempt = 1; ; attempt += 1) {
    const readActivatedAt: number | undefined = markoff.activatedAt;
    const revertNow = Math.floor(Date.now() / 1000);
    const revertEventTime = new Date(
      Math.max(Date.now(), readActivatedAt !== undefined ? (readActivatedAt + 1) * 1000 : 0),
    ).toISOString();
    const revertEventId = randomUUID();
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: tableName,
                Key: { pk, sk },
                UpdateExpression: 'SET revertedAt = :now',
                ConditionExpression:
                  readActivatedAt === undefined
                    ? 'attribute_exists(sk) AND attribute_not_exists(revertedAt) AND attribute_not_exists(activatedAt)'
                    : 'attribute_exists(sk) AND attribute_not_exists(revertedAt) AND activatedAt = :readActivatedAt',
                ExpressionAttributeValues: {
                  ':now': revertNow,
                  ...(readActivatedAt !== undefined ? { ':readActivatedAt': readActivatedAt } : {}),
                },
              },
            },
            {
              Put: {
                TableName: tableName,
                Item: {
                  pk: buildDeptScopedPk(deptId, 'OUTBOX', 'MEMBER', memberId),
                  sk: `EVT#${revertEventId}`,
                  entityType: 'OUTBOX_ENTRY',
                  eventId: revertEventId,
                  eventType: 'personnel.availability.changed',
                  correlationId: memberId,
                  // The platform drain publishes only rows carrying the full envelope
                  // (eventTime, source, schemaVersion); without them it drops the row silently.
                  eventTime: revertEventTime,
                  source: 'personnel-service',
                  schemaVersion: '1.0',
                  createdAt: revertNow,
                  payload: { deptId, memberId, availabilityState: 'AVAILABLE', startAt },
                },
              },
            },
          ],
        }),
      );
      break;
    } catch (error) {
      const cancellation = asTransactionCancellation(error);
      if (cancellation?.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed') {
        let current;
        try {
          const reread = await ddb.send(
            new GetCommand({ TableName: tableName, Key: { pk, sk }, ConsistentRead: true }),
          );
          current = parseMarkoffItem(reread.Item);
        } catch (readError) {
          logError('availability.expiry.read_failed', readError, correlationId);
          throw readError;
        }
        if (!current) {
          return { outcome: 'SKIPPED_NOT_FOUND' };
        }
        if (current.revertedAt !== undefined) {
          return { outcome: 'SKIPPED_ALREADY_REVERTED' };
        }
        if (attempt >= MAX_REVERT_ATTEMPTS) {
          // Still changing: throw so the scheduler retries rather than leave it marked off.
          throw new Error(`mark-off ${correlationId} kept changing while being reverted`, {
            cause: error,
          });
        }
        markoff = current;
        continue;
      }
      if (cancellation) {
        logError('availability.expiry.write_failed', error, correlationId, {
          cancellationReasons: cancellation.CancellationReasons?.map((r) => r.Code),
        });
        emitOutcomeMetric(METRIC_NAMESPACE, 'ExpiryFailed', 'DynamoDbUnavailable');
        throw error;
      }
      logError('availability.expiry.write_failed', error, correlationId);
      emitOutcomeMetric(METRIC_NAMESPACE, 'ExpiryFailed', 'DynamoDbUnavailable');
      throw error;
    }
  }

  emitOutcomeMetric(METRIC_NAMESPACE, 'ExpiryReverted');
  return { outcome: 'REVERTED' };
};
