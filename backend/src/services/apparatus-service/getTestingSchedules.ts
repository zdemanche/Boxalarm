import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import { withAuthorization, type CedarPrincipalContext, type GuardEvent } from '@boxalarm/authz';
import { buildDeptScopedPk, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { createDynamoClient, readApparatusTableConfig } from './dynamoClient.js';
import type { TestType } from './testRecord.js';

const DEFAULT_MONTHS_AHEAD = 24;
const MAX_MONTHS_AHEAD = 36;

interface GetTestingSchedulesDeps {
  readonly client: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly now: () => Date;
}

interface TestingScheduleEntry {
  readonly unitId: string;
  readonly testType: TestType;
  readonly nextDueDate: string;
}

function monthsAheadFromQuery(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MONTHS_AHEAD;
  }
  return Math.min(parsed, MAX_MONTHS_AHEAD);
}

function monthWindow(now: Date, monthsAhead: number): readonly string[] {
  const months: string[] = [];
  let cursor = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  for (let i = 0; i <= monthsAhead; i += 1) {
    months.push(new Date(cursor).toISOString().slice(0, 7));
    cursor = Date.UTC(new Date(cursor).getUTCFullYear(), new Date(cursor).getUTCMonth() + 1, 1);
  }
  return months;
}

function parseGsi2Sk(gsi2sk: unknown): TestingScheduleEntry | undefined {
  if (typeof gsi2sk !== 'string') {
    return undefined;
  }
  const [nextDueDate, unitId, testType] = gsi2sk.split('#');
  if (!nextDueDate || !unitId || !testType) {
    return undefined;
  }
  return { unitId, testType: testType as TestType, nextDueDate };
}

async function queryMonth(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  yearMonth: string,
): Promise<readonly TestingScheduleEntry[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const output = await client.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI2',
        KeyConditionExpression: 'gsi2pk = :gsi2pk',
        ExpressionAttributeValues: {
          ':gsi2pk': buildDeptScopedPk(deptId, 'DUE', 'APPARATUS_TEST', yearMonth),
        },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(...(output.Items ?? []));
    exclusiveStartKey = output.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items
    .map((item) => parseGsi2Sk(item.gsi2sk))
    .filter((entry): entry is TestingScheduleEntry => entry !== undefined);
}

async function getTestingSchedules(
  event: GuardEvent,
  principal: CedarPrincipalContext,
  deps: GetTestingSchedulesDeps,
): Promise<APIGatewayProxyResultV2> {
  const deptId = toVerifiedDeptId(principal);
  const monthsAhead = monthsAheadFromQuery(event.queryStringParameters?.monthsAhead);
  const months = monthWindow(deps.now(), monthsAhead);

  const results = await Promise.all(
    months.map((yearMonth) => queryMonth(deps.client, deps.tableName, deptId, yearMonth)),
  );
  const schedule = results.flat().sort((a, b) => a.nextDueDate.localeCompare(b.nextDueDate));

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(schedule),
  };
}

interface GetTestingSchedulesOverrides {
  readonly client?: DynamoDBDocumentClient;
  readonly tableName?: string;
  readonly now?: () => Date;
  readonly authzClient?: VerifiedPermissionsClient;
}

function resolveDeps(overrides: GetTestingSchedulesOverrides): GetTestingSchedulesDeps {
  return {
    client: overrides.client ?? createDynamoClient(process.env),
    tableName: overrides.tableName ?? readApparatusTableConfig(process.env).tableName,
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
