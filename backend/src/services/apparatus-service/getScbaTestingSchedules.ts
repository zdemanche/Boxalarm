import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import {
  badRequestProblem,
  extractTraceId,
  serviceUnavailableProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { buildDeptScopedPk, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { createDynamoClient, readApparatusTableConfig } from './dynamoClient.js';
import { parseScbaDueItem, type ScbaDueItem } from './scbaRecord.js';

const DEFAULT_WITHIN_DAYS = 30;
const MAX_WITHIN_DAYS = 366;
export const MS_PER_DAY = 24 * 60 * 60 * 1000;
const METRIC_NAMESPACE = 'Boxalarm/ApparatusService';

interface GetScbaTestingSchedulesDeps {
  readonly client: DynamoDBDocumentClient;
  readonly tableName: string;
}

function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

export function monthsWithinWindow(now: Date, withinDays: number): readonly string[] {
  const end = new Date(now.getTime() + withinDays * MS_PER_DAY);
  const months: string[] = [];
  const cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const endMonth = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  while (cursor.getTime() <= endMonth.getTime()) {
    months.push(monthKey(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

export async function queryScbaDueInMonth(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  yearMonth: string,
): Promise<readonly ScbaDueItem[]> {
  const items: ScbaDueItem[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI2',
        KeyConditionExpression: 'gsi2pk = :pk',
        ExpressionAttributeValues: {
          ':pk': buildDeptScopedPk(deptId, 'DUE', 'SCBA_TEST', yearMonth),
        },
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    items.push(...((result.Items ?? []) as ScbaDueItem[]));
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return items;
}

export function isDueWithin(item: ScbaDueItem, now: Date, withinDays: number): boolean {
  const dueDate = String(item.gsi2sk).split('#')[0];
  const dueMs = Date.parse(`${dueDate}T00:00:00Z`);
  if (Number.isNaN(dueMs)) {
    return false;
  }
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const daysUntilDue = Math.round((dueMs - todayMs) / MS_PER_DAY);
  return daysUntilDue <= withinDays;
}

async function getScbaTestingSchedules(
  event: GuardEvent,
  principal: CedarPrincipalContext,
  deps: GetScbaTestingSchedulesDeps,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const deptId = toVerifiedDeptId(principal);

  const rawWithinDays = event.queryStringParameters?.withinDays;
  let withinDays = DEFAULT_WITHIN_DAYS;
  if (rawWithinDays !== undefined) {
    const parsed = Number(rawWithinDays);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_WITHIN_DAYS) {
      return badRequestProblem(
        traceId,
        `withinDays must be an integer between 0 and ${MAX_WITHIN_DAYS} when provided`,
      );
    }
    withinDays = parsed;
  }

  const now = new Date();
  try {
    const months = monthsWithinWindow(now, withinDays);
    const results = await Promise.all(
      months.map((yearMonth) =>
        queryScbaDueInMonth(deps.client, deps.tableName, deptId, yearMonth),
      ),
    );
    const dueSoon = results
      .flat()
      .filter((item) => isDueWithin(item, now, withinDays))
      .map((item) => parseScbaDueItem(item));

    emitOutcomeMetric(METRIC_NAMESPACE, 'ScbaSchedulesQueried');
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dueSoon }),
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'scba.testing_schedules.query_failed',
        correlationId: traceId,
        deptId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    emitOutcomeMetric(METRIC_NAMESPACE, 'ScbaSchedulesQueryFailed');
    return serviceUnavailableProblem(traceId);
  }
}

interface GetScbaTestingSchedulesOverrides {
  readonly client?: DynamoDBDocumentClient;
  readonly tableName?: string;
  readonly authzClient?: VerifiedPermissionsClient;
}

function resolveDeps(overrides: GetScbaTestingSchedulesOverrides): GetScbaTestingSchedulesDeps {
  return {
    client: overrides.client ?? createDynamoClient(process.env),
    tableName: overrides.tableName ?? readApparatusTableConfig(process.env).tableName,
  };
}

export function createGetScbaTestingSchedulesHandler(
  overrides: GetScbaTestingSchedulesOverrides = {},
): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  return withAuthorization(
    (event, principal) => getScbaTestingSchedules(event, principal, resolveDeps(overrides)),
    {
      actionType: 'Boxalarm::Action',
      actionId: 'ViewScbaTestingSchedules',
      resourceType: 'Boxalarm::Department',
      resourceId: (event) => event.requestContext.authorizer?.lambda?.deptId ?? '',
      ...(overrides.authzClient !== undefined ? { client: overrides.authzClient } : {}),
    },
  );
}

export const handler = createGetScbaTestingSchedulesHandler();
