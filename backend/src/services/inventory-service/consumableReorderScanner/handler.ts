import { createHash } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { PutCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import AWSXRay from 'aws-xray-sdk-core';
import type { Handler, ScheduledEvent } from 'aws-lambda';
import { buildDeptScopedPk, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { getDocClient, readInventoryConfig } from '../lib/dynamoDb.js';
import { queryConsumablesBelowThreshold } from '../consumables/consumableRepository.js';

const METRIC_NAMESPACE = 'Boxalarm/InventoryReorderScanner';
const SERVICE_NAME = 'inventory-service';
const EVENT_SOURCE = 'inventory-service';
const PUBLISH_CONCURRENCY = 10;

export interface EventBridgeBusConfig {
  readonly busName: string;
}

export function readPlatformEventBusConfig(env: NodeJS.ProcessEnv): EventBridgeBusConfig {
  const busName = env.PLATFORM_EVENT_BUS_NAME;
  if (!busName) {
    throw new Error('PLATFORM_EVENT_BUS_NAME is required and was not set');
  }
  return { busName };
}

let cachedEventBridgeClient: EventBridgeClient | undefined;

export function createEventBridgeClient(client?: EventBridgeClient): EventBridgeClient {
  if (client) {
    cachedEventBridgeClient = client;
    return client;
  }
  cachedEventBridgeClient ??= AWSXRay.captureAWSv3Client(new EventBridgeClient({}));
  return cachedEventBridgeClient;
}

export interface PublishReorderDueEventParams {
  readonly deptId: VerifiedDeptId;
  readonly itemId: string;
  readonly itemName: string;
  readonly currentQty: number;
  readonly reorderThreshold: number;
  readonly correlationId: string;
  readonly now: Date;
}

export type PublishReorderDueEventOutcome = 'Published' | 'SkippedDuplicate';

function deterministicEventId(deptId: string, itemId: string, today: string): string {
  const hash = createHash('sha256').update(`${deptId}#${itemId}#${today}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

function logPublishError(
  event: string,
  error: unknown,
  correlationId: string,
  itemId: string,
): void {
  console.error(
    JSON.stringify({
      event,
      service: SERVICE_NAME,
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      correlationId,
      itemId,
    }),
  );
}

export async function publishReorderDueEvent(
  ddb: DynamoDBDocumentClient,
  eb: EventBridgeClient,
  env: NodeJS.ProcessEnv,
  tableName: string,
  params: PublishReorderDueEventParams,
): Promise<PublishReorderDueEventOutcome> {
  const { busName } = readPlatformEventBusConfig(env);
  const today = params.now.toISOString().slice(0, 10);
  const markerKey = {
    pk: buildDeptScopedPk(params.deptId, 'CONSUMABLE_REORDER_FLAG', today),
    sk: `CONSUMABLE#${params.itemId}`,
  };
  const eventId = deterministicEventId(params.deptId, params.itemId, today);

  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          ...markerKey,
          entityType: 'CONSUMABLE_REORDER_FLAG',
          flaggedAt: params.now.toISOString(),
          eventId,
        },
        ConditionExpression: 'attribute_not_exists(pk) OR attribute_not_exists(publishedAt)',
      }),
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      emitOutcomeMetric(METRIC_NAMESPACE, 'SkippedDuplicate');
      return 'SkippedDuplicate';
    }
    logPublishError(
      'consumableReorderScanner.markDuplicate.failed',
      error,
      params.correlationId,
      params.itemId,
    );
    throw error;
  }

  let response;
  try {
    response = await eb.send(
      new PutEventsCommand({
        Entries: [
          {
            Source: EVENT_SOURCE,
            DetailType: 'inventory.reorder.due',
            EventBusName: busName,
            Detail: JSON.stringify({
              eventId,
              eventTime: params.now.toISOString(),
              eventType: 'inventory.reorder.due',
              source: EVENT_SOURCE,
              correlationId: params.correlationId,
              schemaVersion: '1.0',
              payload: {
                itemId: params.itemId,
                itemName: params.itemName,
                currentQty: params.currentQty,
                reorderThreshold: params.reorderThreshold,
                deptId: params.deptId,
              },
            }),
          },
        ],
      }),
    );
  } catch (error) {
    logPublishError(
      'consumableReorderScanner.publish.failed',
      error,
      params.correlationId,
      params.itemId,
    );
    emitOutcomeMetric(METRIC_NAMESPACE, 'PublishFailed');
    throw error;
  }

  const entryResult = response.Entries?.[0];
  if (entryResult?.ErrorCode) {
    const error = new Error(entryResult.ErrorMessage ?? entryResult.ErrorCode);
    logPublishError(
      'consumableReorderScanner.publish.entryFailed',
      error,
      params.correlationId,
      params.itemId,
    );
    emitOutcomeMetric(METRIC_NAMESPACE, 'PublishFailed', entryResult.ErrorCode);
    throw error;
  }

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: markerKey,
        UpdateExpression: 'SET publishedAt = :publishedAt',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: { ':publishedAt': params.now.toISOString() },
      }),
    );
  } catch (error) {
    logPublishError(
      'consumableReorderScanner.markPublished.failed',
      error,
      params.correlationId,
      params.itemId,
    );
  }

  emitOutcomeMetric(METRIC_NAMESPACE, 'Published');
  return 'Published';
}

async function publishWithBoundedConcurrency<T>(
  items: readonly T[],
  publish: (item: T) => Promise<void>,
): Promise<void> {
  for (let start = 0; start < items.length; start += PUBLISH_CONCURRENCY) {
    const chunk = items.slice(start, start + PUBLISH_CONCURRENCY);
    await Promise.all(chunk.map((item) => publish(item)));
  }
}

function readScannerDeptId(env: NodeJS.ProcessEnv): string {
  const deptId = env.INVENTORY_REORDER_SCANNER_DEPT_ID;
  if (!deptId) {
    throw new Error('INVENTORY_REORDER_SCANNER_DEPT_ID is required and was not set');
  }
  return deptId;
}

export interface ConsumableReorderScannerDeps {
  readonly dynamoClient?: DynamoDBDocumentClient;
  readonly eventBridgeClient?: EventBridgeClient;
  readonly now?: Date;
}

export async function runConsumableReorderScan(
  correlationId: string,
  deps: ConsumableReorderScannerDeps = {},
): Promise<void> {
  const now = deps.now ?? new Date();
  const deptId = toVerifiedDeptId({ deptId: readScannerDeptId(process.env) });
  const ddb = getDocClient(deps.dynamoClient);
  const eb = createEventBridgeClient(deps.eventBridgeClient);

  try {
    const { tableName } = readInventoryConfig(process.env);
    const belowThreshold = await queryConsumablesBelowThreshold(ddb, tableName, deptId);

    emitOutcomeMetric(METRIC_NAMESPACE, 'Scanned');
    await publishWithBoundedConcurrency(belowThreshold, (item) =>
      publishReorderDueEvent(ddb, eb, process.env, tableName, {
        deptId,
        itemId: item.itemId,
        itemName: item.itemName,
        currentQty: item.stockLevel,
        reorderThreshold: item.reorderThreshold,
        correlationId,
        now,
      }).then(() => undefined),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'consumableReorderScanner.scan.failed',
        service: SERVICE_NAME,
        reason: error instanceof Error ? error.constructor.name : 'UnknownError',
        correlationId,
        deptId,
      }),
    );
    emitOutcomeMetric(METRIC_NAMESPACE, 'ScanFailed');
    throw error;
  }
}

export const handler: Handler<ScheduledEvent, void> = async (event) => {
  await runConsumableReorderScan(event.id);
};
