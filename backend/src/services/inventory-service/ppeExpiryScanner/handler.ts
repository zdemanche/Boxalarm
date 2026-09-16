import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import type { Handler, ScheduledEvent } from 'aws-lambda';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { createInventoryDynamoClient, readInventoryConfig } from '../lifecycle/repository.js';
import { queryPpeAssignmentsDueInMonth, type PpeDueRecord } from '../ppe/repository.js';
import {
  monthPartitionsForScan,
  readPpeExpiryLeadDays,
  selectWithinLeadTime,
} from './configReader.js';
import { createEventBridgeClient, publishDueEvent } from './publishDueEvents.js';

const METRIC_NAMESPACE = 'Boxalarm/PpeExpiryScanner';
const SERVICE_NAME = 'inventory';
const PUBLISH_CONCURRENCY = 10;

async function publishWithBoundedConcurrency(
  dueRecords: readonly PpeDueRecord[],
  publish: (record: PpeDueRecord) => Promise<void>,
): Promise<void> {
  for (let start = 0; start < dueRecords.length; start += PUBLISH_CONCURRENCY) {
    const chunk = dueRecords.slice(start, start + PUBLISH_CONCURRENCY);
    await Promise.all(chunk.map((record) => publish(record)));
  }
}

function readScannerDeptId(env: NodeJS.ProcessEnv): string {
  const deptId = env.PPE_SCANNER_DEPT_ID;
  if (!deptId) {
    throw new Error('PPE_SCANNER_DEPT_ID is required and was not set');
  }
  return deptId;
}

export interface PpeExpiryScannerDeps {
  readonly dynamoClient?: DynamoDBDocumentClient;
  readonly eventBridgeClient?: EventBridgeClient;
  readonly now?: Date;
}

export async function runPpeExpiryScan(
  correlationId: string,
  deps: PpeExpiryScannerDeps = {},
): Promise<void> {
  const now = deps.now ?? new Date();
  const deptId = toVerifiedDeptId({ deptId: readScannerDeptId(process.env) });
  const ddb = createInventoryDynamoClient(process.env, deps.dynamoClient);
  const eb = createEventBridgeClient(deps.eventBridgeClient);
  const config = readInventoryConfig(process.env);

  try {
    const leadDays = await readPpeExpiryLeadDays(ddb, process.env, deptId, correlationId);
    const monthPartitions = monthPartitionsForScan(now, leadDays);
    const results = await Promise.all(
      monthPartitions.map((yearMonth) =>
        queryPpeAssignmentsDueInMonth(ddb, config, { deptId, yearMonth, correlationId }),
      ),
    );
    const dueRecords = selectWithinLeadTime(results.flat(), now, leadDays);

    emitOutcomeMetric(METRIC_NAMESPACE, 'Scanned');
    await publishWithBoundedConcurrency(dueRecords, (record) =>
      publishDueEvent(ddb, eb, process.env, {
        deptId,
        memberId: record.memberId,
        ppeItemId: record.ppeItemId,
        expiryDate: record.expiryDate,
        correlationId,
        now,
      }).then(() => undefined),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'ppeExpiryScanner.scan.failed',
        service: SERVICE_NAME,
        reason: error instanceof Error ? error.message : String(error),
        errorType: error instanceof Error ? error.constructor.name : 'UnknownError',
        correlationId,
        deptId,
      }),
    );
    emitOutcomeMetric(METRIC_NAMESPACE, 'ScanFailed');
    throw error;
  }
}

export const handler: Handler<ScheduledEvent, void> = async (event) => {
  await runPpeExpiryScan(event.id);
};
