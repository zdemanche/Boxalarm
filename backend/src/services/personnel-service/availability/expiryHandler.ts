import { randomUUID } from 'node:crypto';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { createDdbClient, parseMarkoffItem, readPersonnelDdbConfig } from './dynamoClient.js';

const METRIC_NAMESPACE = 'Boxalarm/personnel-availability';

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

  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tableName,
              Key: { pk, sk },
              UpdateExpression: 'SET revertedAt = :now',
              ConditionExpression: 'attribute_exists(sk) AND attribute_not_exists(revertedAt)',
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
                createdAt: nowSeconds,
                payload: { deptId, memberId, availabilityState: 'AVAILABLE', startAt },
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
        return { outcome: 'SKIPPED_ALREADY_REVERTED' };
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

  emitOutcomeMetric(METRIC_NAMESPACE, 'ExpiryReverted');
  return { outcome: 'REVERTED' };
};
