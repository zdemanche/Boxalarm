import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import type { Handler, ScheduledEvent } from 'aws-lambda';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { queryTestsDue } from './testsDueRepository.js';
import { createDynamoClient } from '../dynamoClient.js';
import { dueWindowForScan, readApparatusTestLeadDays, selectWithinLeadTime } from './configReader.js';
import { createEventBridgeClient, publishDueEvent } from './publishDueEvents.js';

const METRIC_NAMESPACE = 'Boxalarm/ApparatusTestDueScanner';
const SERVICE_NAME = 'apparatus';
const PUBLISH_CONCURRENCY = 10;

async function publishWithBoundedConcurrency(
  dueRecords: readonly {
    readonly apparatusId: string;
    readonly testType: string;
    readonly dueDate: string;
  }[],
  publish: (record: (typeof dueRecords)[number]) => Promise<void>,
): Promise<void> {
  for (let start = 0; start < dueRecords.length; start += PUBLISH_CONCURRENCY) {
    const chunk = dueRecords.slice(start, start + PUBLISH_CONCURRENCY);
    await Promise.all(chunk.map((record) => publish(record)));
  }
}

function readScannerDeptId(env: NodeJS.ProcessEnv): string {
  const deptId = env.APPARATUS_TEST_SCANNER_DEPT_ID;
  if (!deptId) {
    throw new Error('APPARATUS_TEST_SCANNER_DEPT_ID is required and was not set');
  }
  return deptId;
}

export interface ApparatusTestDueScannerDeps {
  readonly dynamoClient?: DynamoDBDocumentClient;
  readonly eventBridgeClient?: EventBridgeClient;
  readonly now?: Date;
}

export async function runApparatusTestDueScan(
  correlationId: string,
  deps: ApparatusTestDueScannerDeps = {},
): Promise<void> {
  const now = deps.now ?? new Date();
  const deptId = toVerifiedDeptId({ deptId: readScannerDeptId(process.env) });
  const ddb = createDynamoClient(process.env, deps.dynamoClient);
  const eb = createEventBridgeClient(deps.eventBridgeClient);

  try {
    const leadDays = await readApparatusTestLeadDays(ddb, process.env, deptId, correlationId);
    const window = dueWindowForScan(now, leadDays);
    const results = await queryTestsDue(ddb, process.env, {
      deptId,
      startDate: window.startDate,
      endDate: window.endDate,
      correlationId,
    });
    const dueRecords = selectWithinLeadTime(results, now, leadDays);

    emitOutcomeMetric(METRIC_NAMESPACE, 'Scanned');
    await publishWithBoundedConcurrency(dueRecords, (record) =>
      publishDueEvent(ddb, eb, process.env, {
        deptId,
        apparatusId: record.apparatusId,
        testType: record.testType,
        dueDate: record.dueDate,
        correlationId,
        now,
      }).then(() => undefined),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'testDueScanner.scan.failed',
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
  await runApparatusTestDueScan(event.id);
};
