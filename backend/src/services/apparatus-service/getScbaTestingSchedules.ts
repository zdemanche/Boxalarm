import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import {
  badRequestProblem,
  extractTraceId,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { buildDeptScopedPk, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { createDynamoClient, readApparatusTableConfig } from './dynamoClient.js';
import { parseScbaMetadataItem, type ScbaMetadataItem } from './scbaRecord.js';

const DEFAULT_WITHIN_DAYS = 30;
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface GetScbaTestingSchedulesDeps {
  readonly client: DynamoDBDocumentClient;
  readonly tableName: string;
}

function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

export function monthsWithinWindow(now: Date, withinDays: number): readonly string[] {
  const end = new Date(now.getTime() + withinDays * MS_PER_DAY);
  return Array.from(
    new Set([
      monthKey(now),
      monthKey(new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1))),
    ]),
  );
}

export async function queryScbaDueInMonth(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  yearMonth: string,
): Promise<readonly ScbaMetadataItem[]> {
  const items: ScbaMetadataItem[] = [];
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
    items.push(...((result.Items ?? []) as ScbaMetadataItem[]));
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return items;
}

export function isDueWithin(item: ScbaMetadataItem, now: Date, withinDays: number): boolean {
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
    if (!Number.isFinite(parsed)) {
      return badRequestProblem(traceId, 'withinDays must be a finite number when provided');
    }
    withinDays = parsed;
  }

  const now = new Date();
  const months = monthsWithinWindow(now, withinDays);
  const results = await Promise.all(
    months.map((yearMonth) => queryScbaDueInMonth(deps.client, deps.tableName, deptId, yearMonth)),
  );
  const dueSoon = results
    .flat()
    .filter((item) => isDueWithin(item, now, withinDays))
    .map((item) => parseScbaMetadataItem(item, deptId));

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dueSoon }),
  };
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
