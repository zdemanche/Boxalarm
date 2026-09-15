import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import type { Handler, ScheduledEvent } from 'aws-lambda';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { getDocClient, readInventoryConfig } from '../lib/dynamoDb.js';
import { queryConsumablesBelowThreshold } from '../consumables/consumableRepository.js';
import { createEventBridgeClient, publishReorderDueEvent } from './publishReorderDueEvent.js';

const METRIC_NAMESPACE = 'Boxalarm/InventoryReorderScanner';
const SERVICE_NAME = 'inventory-service';
const PUBLISH_CONCURRENCY = 10;

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
