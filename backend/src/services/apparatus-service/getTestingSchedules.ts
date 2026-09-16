import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import {
  extractTraceId,
  serviceUnavailableProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { buildDeptScopedPk, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { createApparatusRepository, type ApparatusRepository } from './apparatusRepository.js';
import { createDynamoClient, readApparatusTableConfig } from './dynamoClient.js';
import { parseTestDueItem, type TestDueItem } from './testRecord.js';

const DEFAULT_MONTHS_AHEAD = 24;
const MAX_MONTHS_AHEAD = 36;
const METRIC_NAMESPACE = 'Boxalarm/Apparatus';
// Sorts after any real apparatusId/testType suffix, so `sk BETWEEN start AND end#SENTINEL`
// correctly includes every entry whose date component equals the end date.
const RANGE_END_SENTINEL = '￿';

interface GetTestingSchedulesDeps {
  readonly client: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly apparatusRepository: ApparatusRepository;
  readonly now: () => Date;
}

interface TestingScheduleEntry {
  readonly unitId: string;
  readonly testType: string;
  readonly nextDueDate: string;
}

function monthsAheadFromQuery(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MONTHS_AHEAD;
  }
  return Math.min(parsed, MAX_MONTHS_AHEAD);
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Last day of the month that is `monthsAhead` months after `now`, inclusive. */
function windowEndDate(now: Date, monthsAhead: number): string {
  const lastDayOfTargetMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthsAhead + 1, 0),
  );
  return isoDate(lastDayOfTargetMonth);
}

async function queryDueWindow(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  startDate: string,
  endDate: string,
): Promise<readonly TestDueItem[]> {
  const items: TestDueItem[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const output = await client.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI2',
        KeyConditionExpression: 'gsi2pk = :gsi2pk AND gsi2sk BETWEEN :start AND :end',
        ExpressionAttributeValues: {
          ':gsi2pk': buildDeptScopedPk(deptId, 'DUE', 'APPARATUS_TEST'),
          ':start': startDate,
          ':end': `${endDate}#${RANGE_END_SENTINEL}`,
        },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(...((output.Items ?? []) as TestDueItem[]));
    exclusiveStartKey = output.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}

async function getTestingSchedules(
  event: GuardEvent,
  principal: CedarPrincipalContext,
  deps: GetTestingSchedulesDeps,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const deptId = toVerifiedDeptId(principal);
  const monthsAhead = monthsAheadFromQuery(event.queryStringParameters?.monthsAhead);
  const now = deps.now();

  try {
    const dueItems = await queryDueWindow(
      deps.client,
      deps.tableName,
      deptId,
      isoDate(now),
      windowEndDate(now, monthsAhead),
    );
    const apparatusList = await deps.apparatusRepository.listApparatus(deptId);
    const unitIdByApparatusId = new Map(apparatusList.map((a) => [a.apparatusId, a.unitId]));

    const schedule: TestingScheduleEntry[] = dueItems
      .map(parseTestDueItem)
      .map((entry) => ({
        unitId: unitIdByApparatusId.get(entry.apparatusId) ?? entry.apparatusId,
        testType: entry.testType,
        nextDueDate: entry.nextDueDate,
      }))
      .sort((a, b) => a.nextDueDate.localeCompare(b.nextDueDate));

    emitOutcomeMetric(METRIC_NAMESPACE, 'TestingSchedulesFetched');
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(schedule),
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'apparatusTest.testingSchedules.query_failed',
        correlationId: traceId,
        deptId,
        monthsAhead,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    emitOutcomeMetric(METRIC_NAMESPACE, 'TestingSchedulesFetchFailed');
    return serviceUnavailableProblem(traceId);
  }
}

interface GetTestingSchedulesOverrides {
  readonly client?: DynamoDBDocumentClient;
  readonly tableName?: string;
  readonly apparatusRepository?: ApparatusRepository;
  readonly now?: () => Date;
  readonly authzClient?: VerifiedPermissionsClient;
}

function resolveDeps(overrides: GetTestingSchedulesOverrides): GetTestingSchedulesDeps {
  const client = overrides.client ?? createDynamoClient(process.env);
  const tableName = overrides.tableName ?? readApparatusTableConfig(process.env).tableName;
  return {
    client,
    tableName,
    apparatusRepository:
      overrides.apparatusRepository ?? createApparatusRepository(client, tableName),
    now: overrides.now ?? (() => new Date()),
  };
}

export function createGetTestingSchedulesHandler(
  overrides: GetTestingSchedulesOverrides = {},
): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  return withAuthorization(
    (event, principal) => getTestingSchedules(event, principal, resolveDeps(overrides)),
    {
      actionType: 'Boxalarm::Action',
      actionId: 'ViewTestingSchedules',
      resourceType: 'Boxalarm::Apparatus',
      resourceId: () => 'ALL',
      ...(overrides.authzClient !== undefined ? { client: overrides.authzClient } : {}),
    },
  );
}

export const handler = createGetTestingSchedulesHandler();
