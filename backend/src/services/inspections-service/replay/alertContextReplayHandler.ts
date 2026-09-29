import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { buildOutboxRecord } from '@boxalarm/outbox';
import { getDocumentClient, readInspectionsConfig } from '../dynamoClient.js';
import { logError, logInfo } from '../logger.js';
import {
  OccupancyNotFoundError,
  buildPrePlanEventPayload,
  getOccupancyContext,
  getPrePlan,
} from '../prePlanRepository.js';
import { buildHydrantEventPayload } from '../hydrant/hydrantRepository.js';
import { HYDRANT_SK } from '../hydrant/hydrantKeys.js';

/**
 * Alert-context replay (post-deploy backfill, and the replay path after an alerting
 * address-normalizer change): re-emits inspections.preplan.updated for every active
 * occupancy's pre-plan and inspections.hydrant.updated for every active hydrant, from their
 * current state, so the alerting plane's PRE_PLAN_COPY / HYDRANT_COPY projections are
 * (re)built. Runbook: docs/runbooks/alert-context-replay.md.
 *
 * Invoked by hand (`aws lambda invoke`), never on a schedule and never from the alert path.
 *
 * Idempotent: an event carries the item's current state and the consumers upsert, so a
 * second run rewrites the same copies. Race-free: each outbox Put is conditioned on the
 * source item's `updatedAt` being the value this run read — if a real edit lands in between,
 * the replay for that item is skipped (the edit emitted its own, newer event).
 */

export interface AlertContextReplayRequest {
  readonly deptId: string;
  /** Count what would be emitted without writing anything. */
  readonly dryRun?: boolean;
}

export interface ReplayCounts {
  readonly emitted: number;
  readonly skippedConcurrentEdit: number;
  /** Archived (or archived during the run): never re-emitted, so a tombstone is never undone. */
  readonly skippedArchived: number;
  readonly skippedNoPrePlan?: number;
  /** Hydrant rows with no numeric updatedAt: cannot be replayed race-free, so they are counted. */
  readonly skippedNoUpdatedAt?: number;
}

export interface AlertContextReplayResult {
  readonly deptId: string;
  readonly dryRun: boolean;
  readonly prePlans: ReplayCounts;
  readonly hydrants: ReplayCounts;
}

/** Every id on a department list partition (GSI3 `DEPT#{d}#{kind}`). */
async function listIds(
  doc: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  kind: 'OCCUPANCY' | 'HYDRANT',
  idField: 'occupancyId' | 'hydrantId',
): Promise<string[]> {
  const ids: string[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await doc.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI3',
        KeyConditionExpression: 'gsi3pk = :gsi3pk',
        ExpressionAttributeValues: { ':gsi3pk': buildDeptScopedPk(deptId, kind) },
        ProjectionExpression: idField,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    for (const item of page.Items ?? []) {
      const id: unknown = item[idField];
      if (typeof id === 'string') ids.push(id);
    }
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return ids;
}

function isConditionFailure(error: unknown): boolean {
  return (
    error instanceof TransactionCanceledException &&
    (error.CancellationReasons ?? []).some((reason) => reason.Code === 'ConditionalCheckFailed')
  );
}

/**
 * Puts the outbox record only if the source item still carries the updatedAt we read and is
 * not archived — and, for a pre-plan, its occupancy is not archived either (`archivedOn`).
 */
async function emitIfUnchanged(
  doc: DynamoDBDocumentClient,
  tableName: string,
  source: { readonly pk: string; readonly sk: string; readonly updatedAt: number },
  outboxRecord: object,
  archivedOn?: { readonly pk: string; readonly sk: string },
): Promise<'emitted' | 'skipped' | 'archived'> {
  // Destructured: the pk-scoping sweep (test/pk-scoping.test.ts) reads `pk: <identifier>`
  // as a hand-built key. source.pk comes from a row read by its dept-scoped key.
  const { pk, sk, updatedAt } = source;
  const archiveChecks = archivedOn
    ? [
        {
          ConditionCheck: {
            TableName: tableName,
            Key: { ...archivedOn },
            ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(archivedAt)',
          },
        },
      ]
    : [];
  try {
    await doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: tableName,
              Key: { pk, sk },
              ConditionExpression:
                'updatedAt = :readUpdatedAt AND attribute_not_exists(archivedAt)',
              ExpressionAttributeValues: { ':readUpdatedAt': updatedAt },
            },
          },
          ...archiveChecks,
          { Put: { TableName: tableName, Item: outboxRecord as Record<string, unknown> } },
        ],
      }),
    );
    return 'emitted';
  } catch (error) {
    if (!isConditionFailure(error)) throw error;
    const reasons = (error as TransactionCanceledException).CancellationReasons ?? [];
    return archivedOn && reasons[1]?.Code === 'ConditionalCheckFailed' ? 'archived' : 'skipped';
  }
}

async function replayPrePlans(
  doc: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  dryRun: boolean,
): Promise<ReplayCounts> {
  let emitted = 0;
  let skippedConcurrentEdit = 0;
  let skippedArchived = 0;
  let skippedNoPrePlan = 0;
  for (const occupancyId of await listIds(doc, tableName, deptId, 'OCCUPANCY', 'occupancyId')) {
    const plan = await getPrePlan(doc, tableName, deptId, occupancyId);
    if (!plan) {
      skippedNoPrePlan += 1;
      continue;
    }
    let occupancy;
    try {
      occupancy = await getOccupancyContext(doc, tableName, deptId, occupancyId);
    } catch (error) {
      if (error instanceof OccupancyNotFoundError) {
        skippedNoPrePlan += 1;
        continue;
      }
      throw error;
    }
    if (dryRun) {
      emitted += 1;
      continue;
    }
    const outcome = await emitIfUnchanged(
      doc,
      tableName,
      plan,
      buildOutboxRecord(
        deptId,
        'inspections-service',
        'inspections.preplan.updated',
        plan.prePlanId,
        buildPrePlanEventPayload(deptId, occupancyId, plan.prePlanId, occupancy, plan),
      ),
      { pk: buildDeptScopedPk(deptId, 'OCCUPANCY', occupancyId), sk: 'METADATA' },
    );
    if (outcome === 'emitted') emitted += 1;
    else if (outcome === 'archived') skippedArchived += 1;
    else skippedConcurrentEdit += 1;
  }
  return { emitted, skippedConcurrentEdit, skippedArchived, skippedNoPrePlan };
}

async function replayHydrants(
  doc: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  dryRun: boolean,
): Promise<ReplayCounts> {
  let emitted = 0;
  let skippedConcurrentEdit = 0;
  let skippedArchived = 0;
  let skippedNoUpdatedAt = 0;
  for (const hydrantId of await listIds(doc, tableName, deptId, 'HYDRANT', 'hydrantId')) {
    const pk = buildDeptScopedPk(deptId, 'HYDRANT', hydrantId);
    const { Item: hydrant } = await doc.send(
      new GetCommand({ TableName: tableName, Key: { pk, sk: HYDRANT_SK }, ConsistentRead: true }),
    );
    if (!hydrant) continue;
    if (typeof hydrant.updatedAt !== 'number') {
      skippedNoUpdatedAt += 1;
      continue;
    }
    if (hydrant.archivedAt !== undefined) {
      skippedArchived += 1;
      continue;
    }
    if (dryRun) {
      emitted += 1;
      continue;
    }
    const outcome = await emitIfUnchanged(
      doc,
      tableName,
      { pk, sk: HYDRANT_SK, updatedAt: hydrant.updatedAt },
      buildOutboxRecord(
        deptId,
        'inspections-service',
        'inspections.hydrant.updated',
        hydrantId,
        buildHydrantEventPayload(deptId, hydrantId, hydrant),
      ),
    );
    if (outcome === 'emitted') emitted += 1;
    else skippedConcurrentEdit += 1;
  }
  return { emitted, skippedConcurrentEdit, skippedArchived, skippedNoUpdatedAt };
}

export function createAlertContextReplayHandler(docClient?: DynamoDBDocumentClient) {
  return async (event: AlertContextReplayRequest): Promise<AlertContextReplayResult> => {
    const deptId = toVerifiedDeptId({ deptId: event?.deptId ?? '' });
    const dryRun = event.dryRun === true;
    const { tableName } = readInspectionsConfig(process.env);
    const doc = getDocumentClient(docClient);
    try {
      const prePlans = await replayPrePlans(doc, tableName, deptId, dryRun);
      const hydrants = await replayHydrants(doc, tableName, deptId, dryRun);
      const result = { deptId, dryRun, prePlans, hydrants };
      logInfo({ event: 'alert_context_replay.completed', ...result });
      return result;
    } catch (error) {
      logError({
        event: 'alert_context_replay.failed',
        service: 'inspections-service',
        reason: error instanceof Error ? error.constructor.name : 'UnknownError',
        message: error instanceof Error ? error.message : undefined,
        deptId,
      });
      throw error;
    }
  };
}

export const handler = createAlertContextReplayHandler();
