import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import type { SQSEvent } from 'aws-lambda';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
import {
  parseHydrantUpdatePayload,
  resolveNearestHydrants,
  type HydrantUpdatePayload,
  type NearestHydrant,
} from './nearestHydrants.js';

const METRIC_NAMESPACE = 'Boxalarm/alerting-pre-plan';
const MAX_NEAREST_HYDRANTS = 5;
const MAX_UPDATE_ATTEMPTS = 3;

interface HydrantUpdatedEnvelope {
  readonly eventId: string;
  readonly eventTime: string;
  readonly payload: HydrantUpdatePayload;
}

function parseEnvelope(body: string): HydrantUpdatedEnvelope {
  const raw = JSON.parse(body) as Record<string, unknown>;
  const eventId = raw.eventId;
  const eventTime = raw.eventTime;
  if (
    typeof eventId !== 'string' ||
    typeof eventTime !== 'string' ||
    !Number.isFinite(Date.parse(eventTime))
  ) {
    throw new Error('inspections.hydrant.updated event failed shape validation');
  }
  const payload = parseHydrantUpdatePayload(raw.payload);
  return { eventId, eventTime, payload };
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
      service: 'alerting-service',
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      message: error instanceof Error ? error.message : undefined,
      correlationId,
      ...extra,
    }),
  );
}

interface PrePlanCopyItem {
  readonly pk: string;
  readonly sk: string;
  readonly nearestHydrants?: readonly NearestHydrant[];
  readonly hydrantsUpdatedAt?: number;
}

async function queryPrePlanCopies(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
): Promise<readonly PrePlanCopyItem[]> {
  const items: PrePlanCopyItem[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': buildDeptScopedPk(deptId, 'PREPLAN') },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const item of (result.Items ?? []) as PrePlanCopyItem[]) {
      items.push(item);
    }
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey !== undefined);
  return items;
}

type CopyUpdateOutcome = 'updated' | 'staleDiscarded' | 'notFound';

async function applyHydrantUpdate(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  copy: PrePlanCopyItem,
  payload: HydrantUpdatePayload,
  snapshotUpdatedAt: number,
): Promise<CopyUpdateOutcome> {
  let current = copy;
  for (let attempt = 1; attempt <= MAX_UPDATE_ATTEMPTS; attempt += 1) {
    const prevNearestHydrants = current.nearestHydrants;
    // ponytail: referenceLocation is always null on the real event path today — no occupancy
    // lat/long is available to this isolation-boundary consumer — see nearestHydrants.ts.
    const nextNearestHydrants = resolveNearestHydrants(
      prevNearestHydrants ?? [],
      payload,
      null,
      MAX_NEAREST_HYDRANTS,
    );
    const watermarkCondition =
      typeof current.hydrantsUpdatedAt === 'number'
        ? ':now > hydrantsUpdatedAt'
        : 'attribute_not_exists(hydrantsUpdatedAt)';
    const listCondition =
      prevNearestHydrants === undefined
        ? 'attribute_not_exists(nearestHydrants)'
        : 'nearestHydrants = :prevNearestHydrants';

    try {
      await ddb.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { pk: buildDeptScopedPk(deptId, 'PREPLAN'), sk: current.sk },
          UpdateExpression:
            'SET nearestHydrants = :nearestHydrants, hydrantsUpdatedAt = :now, snapshotUpdatedAt = :now',
          ConditionExpression: `${watermarkCondition} AND ${listCondition}`,
          ExpressionAttributeValues: {
            ':nearestHydrants': nextNearestHydrants,
            ':now': snapshotUpdatedAt,
            ...(prevNearestHydrants !== undefined
              ? { ':prevNearestHydrants': prevNearestHydrants }
              : {}),
          },
        }),
      );
      return 'updated';
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) {
        throw error;
      }
      const fresh = await ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: { pk: buildDeptScopedPk(deptId, 'PREPLAN'), sk: current.sk },
          ConsistentRead: true,
        }),
      );
      const freshCopy = fresh.Item as PrePlanCopyItem | undefined;
      if (!freshCopy) {
        return 'notFound';
      }
      if (
        typeof freshCopy.hydrantsUpdatedAt === 'number' &&
        freshCopy.hydrantsUpdatedAt >= snapshotUpdatedAt
      ) {
        return 'staleDiscarded';
      }
      current = freshCopy;
    }
  }
  return 'staleDiscarded';
}

export const handler = async (event: SQSEvent): Promise<void> => {
  const { tableName } = readAlertingConfig(process.env);
  const ddb = createDynamoClient(process.env);

  for (const record of event.Records) {
    let envelope: HydrantUpdatedEnvelope;
    try {
      envelope = parseEnvelope(record.body);
    } catch (error) {
      logError('hydrant_copy.malformed_event', error, record.messageId);
      throw error;
    }

    const { eventId, payload } = envelope;
    const snapshotUpdatedAt = Date.parse(envelope.eventTime);
    const deptId = toVerifiedDeptId({ deptId: payload.deptId });

    let copies: readonly PrePlanCopyItem[];
    try {
      copies = await queryPrePlanCopies(ddb, tableName, deptId);
    } catch (error) {
      logError('hydrant_copy.query_failed', error, eventId, { hydrantId: payload.hydrantId });
      emitOutcomeMetric(METRIC_NAMESPACE, 'HydrantCopyFailed');
      throw error;
    }

    const matched = copies.filter((copy) =>
      (copy.nearestHydrants ?? []).some((hydrant) => hydrant.hydrantId === payload.hydrantId),
    );

    if (matched.length === 0) {
      emitOutcomeMetric(METRIC_NAMESPACE, 'HydrantCopyNoMatch');
      continue;
    }

    for (const copy of matched) {
      try {
        const outcome = await applyHydrantUpdate(
          ddb,
          tableName,
          deptId,
          copy,
          payload,
          snapshotUpdatedAt,
        );
        if (outcome === 'staleDiscarded') {
          logError(
            'hydrant_copy.stale_event_discarded',
            new Error('stale or duplicate event'),
            eventId,
            {
              hydrantId: payload.hydrantId,
              occupancySk: copy.sk,
            },
          );
          emitOutcomeMetric(METRIC_NAMESPACE, 'HydrantCopyStaleDiscarded');
        } else if (outcome === 'notFound') {
          emitOutcomeMetric(METRIC_NAMESPACE, 'HydrantCopyNoMatch');
        } else {
          emitOutcomeMetric(METRIC_NAMESPACE, 'HydrantCopyUpdated');
        }
      } catch (error) {
        logError('hydrant_copy.update_failed', error, eventId, {
          hydrantId: payload.hydrantId,
          occupancySk: copy.sk,
        });
        emitOutcomeMetric(METRIC_NAMESPACE, 'HydrantCopyFailed');
        throw error;
      }
    }
  }
};
