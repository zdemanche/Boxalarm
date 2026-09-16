import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import type { Handler, ScheduledEvent } from 'aws-lambda';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { createDynamoClient, readApparatusTableConfig } from '../dynamoClient.js';
import { MS_PER_DAY, monthsWithinWindow, queryScbaDueInMonth } from '../getScbaTestingSchedules.js';
import { parseScbaDueItem } from '../scbaRecord.js';
import { createEventBridgeClient, publishScbaTestDueEvent } from './publishDueEvents.js';

const METRIC_NAMESPACE = 'Boxalarm/ApparatusTestingScanner';
const SERVICE_NAME = 'apparatus-service';
const PUBLISH_CONCURRENCY = 10;
export const DEFAULT_SCBA_TEST_LEAD_DAYS = 7;

function readScannerDeptId(env: NodeJS.ProcessEnv): string {
  const deptId = env.APPARATUS_SCANNER_DEPT_ID;
  if (!deptId) {
    throw new Error('APPARATUS_SCANNER_DEPT_ID is required and was not set');
  }
  return deptId;
}

type DueScbaTest = ReturnType<typeof parseScbaDueItem>;

function isWithinLeadWindow(dueDate: string, now: Date, leadDays: number): boolean {
  const dueMs = Date.parse(`${dueDate}T00:00:00Z`);
  if (Number.isNaN(dueMs)) {
    return false;
  }
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const daysUntilDue = Math.round((dueMs - todayMs) / MS_PER_DAY);
  return daysUntilDue >= 0 && daysUntilDue <= leadDays;
}

async function publishWithBoundedConcurrency(
  dueTests: readonly DueScbaTest[],
  publish: (test: DueScbaTest) => Promise<void>,
): Promise<void> {
  for (let start = 0; start < dueTests.length; start += PUBLISH_CONCURRENCY) {
    const chunk = dueTests.slice(start, start + PUBLISH_CONCURRENCY);
    await Promise.all(chunk.map((test) => publish(test)));
  }
}

export interface ApparatusTestingScannerDeps {
  readonly dynamoClient?: DynamoDBDocumentClient;
  readonly eventBridgeClient?: EventBridgeClient;
  readonly now?: Date;
}

export async function runApparatusTestingScan(
  correlationId: string,
  deps: ApparatusTestingScannerDeps = {},
): Promise<void> {
  const now = deps.now ?? new Date();
  const deptId = toVerifiedDeptId({ deptId: readScannerDeptId(process.env) });
  const ddb = createDynamoClient(process.env, deps.dynamoClient);
  const eb = createEventBridgeClient(deps.eventBridgeClient);
  const leadDays = DEFAULT_SCBA_TEST_LEAD_DAYS;

  let dueTests: readonly DueScbaTest[];
  try {
    const { tableName } = readApparatusTableConfig(process.env);
    const months = monthsWithinWindow(now, leadDays);
    const results = await Promise.all(
      months.map((yearMonth) => queryScbaDueInMonth(ddb, tableName, deptId, yearMonth)),
    );
    dueTests = results
      .flat()
      .map((item) => parseScbaDueItem(item))
      .filter((test) => isWithinLeadWindow(test.dueDate, now, leadDays));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'apparatusTestingScanner.scan.failed',
        service: SERVICE_NAME,
        reason: error instanceof Error ? error.constructor.name : 'UnknownError',
        correlationId,
        deptId,
      }),
    );
    emitOutcomeMetric(METRIC_NAMESPACE, 'ScanFailed');
    throw error;
  }

  emitOutcomeMetric(METRIC_NAMESPACE, 'Scanned');
  await publishWithBoundedConcurrency(dueTests, (test) =>
    publishScbaTestDueEvent(ddb, eb, process.env, {
      deptId,
      apparatusId: test.apparatusId,
      scbaUnitId: test.scbaUnitId,
      cylinderId: test.cylinderId,
      testType: test.testType,
      dueDate: test.dueDate,
      correlationId,
      now,
    }).then(() => undefined),
  );
}

export const handler: Handler<ScheduledEvent, void> = async (event) => {
  await runApparatusTestingScan(event.id);
};
