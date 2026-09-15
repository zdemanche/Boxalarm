import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { readApparatusTableConfig } from '../dynamoClient.js';

export const DEFAULT_APPARATUS_TEST_LEAD_DAYS = 30;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export async function readApparatusTestLeadDays(
  client: DynamoDBDocumentClient,
  env: NodeJS.ProcessEnv,
  deptId: VerifiedDeptId,
  correlationId: string,
): Promise<number> {
  const { tableName } = readApparatusTableConfig(env);
  try {
    const output = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: buildDeptScopedPk(deptId), sk: 'CONFIG#ALERT_RULES' },
      }),
    );
    const value = output.Item?.value as Record<string, unknown> | undefined;
    const leadDays = value?.apparatusTestLeadDays;
    return typeof leadDays === 'number' && Number.isFinite(leadDays) && leadDays > 0
      ? leadDays
      : DEFAULT_APPARATUS_TEST_LEAD_DAYS;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'testDueScanner.config.read_failed',
        service: 'apparatus',
        reason: error instanceof Error ? error.constructor.name : 'UnknownError',
        correlationId,
        deptId,
      }),
    );
    throw error;
  }
}

export function monthPartitionsForScan(now: Date, leadDays: number): readonly string[] {
  const endDate = new Date(now.getTime() + leadDays * MS_PER_DAY);
  const endCursor = Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), 1);
  const months: string[] = [];
  let cursor = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  while (cursor <= endCursor) {
    months.push(new Date(cursor).toISOString().slice(0, 7));
    cursor = Date.UTC(new Date(cursor).getUTCFullYear(), new Date(cursor).getUTCMonth() + 1, 1);
  }
  return months;
}

export function selectWithinLeadTime<T extends { readonly dueDate: string }>(
  records: readonly T[],
  now: Date,
  leadDays: number,
): readonly T[] {
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return records.filter((record) => {
    if (!ISO_DATE.test(record.dueDate)) {
      return false;
    }
    const dueMs = Date.parse(`${record.dueDate}T00:00:00Z`);
    if (Number.isNaN(dueMs)) {
      return false;
    }
    const daysUntilDue = Math.round((dueMs - todayMs) / MS_PER_DAY);
    return daysUntilDue >= 0 && daysUntilDue <= leadDays;
  });
}
