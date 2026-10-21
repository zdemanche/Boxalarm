import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { LosapRepositoryUnavailableError, logLosapError } from './repository.js';

export const DEFAULT_TIME_ZONE = 'America/New_York';
const NERIS_CONFIG_SK = 'CONFIG#NERIS';

function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function zonedYear(epochSeconds: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' }).formatToParts(
    new Date(epochSeconds * 1000),
  );
  return Number(parts.find((part) => part.type === 'year')?.value);
}

export async function getDepartmentTimeZone(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
): Promise<string> {
  try {
    const result = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: buildDeptScopedPk(deptId), sk: NERIS_CONFIG_SK },
      }),
    );
    const timeZone = (result.Item?.value as { timeZone?: unknown } | undefined)?.timeZone;
    return isTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  } catch (error) {
    logLosapError('losap.departmentYear.getDepartmentTimeZone.failed', error, { deptId });
    throw new LosapRepositoryUnavailableError(error);
  }
}

export async function getLosapYear(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  epochSeconds: number,
): Promise<number> {
  return zonedYear(epochSeconds, await getDepartmentTimeZone(client, tableName, deptId));
}
