import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

export const DEFAULT_PPE_EXPIRY_LEAD_DAYS = 30;
export const MAX_PPE_EXPIRY_LEAD_DAYS = 365;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface PlatformConfigDynamoConfig {
  readonly tableName: string;
}

export function readPlatformConfigDynamoConfig(
  env: NodeJS.ProcessEnv,
): PlatformConfigDynamoConfig {
  const tableName = env.PLATFORM_CONFIG_DYNAMO_TABLE_NAME;
  if (!tableName) {
    throw new Error('PLATFORM_CONFIG_DYNAMO_TABLE_NAME is required and was not set');
  }
  return { tableName };
}

export async function readPpeExpiryLeadDays(
  client: DynamoDBDocumentClient,
  env: NodeJS.ProcessEnv,
  deptId: VerifiedDeptId,
  correlationId: string,
): Promise<number> {
  const { tableName } = readPlatformConfigDynamoConfig(env);
  try {
    const output = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: buildDeptScopedPk(deptId), sk: 'CONFIG#ALERT_RULES' },
      }),
    );
    const value = output.Item?.value as Record<string, unknown> | undefined;
    const leadDays = value?.ppeExpiryLeadDays;
    if (typeof leadDays !== 'number' || !Number.isFinite(leadDays) || leadDays <= 0) {
      return DEFAULT_PPE_EXPIRY_LEAD_DAYS;
    }
    return Math.min(leadDays, MAX_PPE_EXPIRY_LEAD_DAYS);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'ppeExpiryScanner.config.read_failed',
        service: 'inventory',
        reason: error instanceof Error ? error.message : String(error),
        errorType: error instanceof Error ? error.constructor.name : 'UnknownError',
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

export function selectWithinLeadTime<T extends { readonly expiryDate: string }>(
  records: readonly T[],
  now: Date,
  leadDays: number,
): readonly T[] {
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return records.filter((record) => {
    if (!ISO_DATE.test(record.expiryDate)) {
      return false;
    }
    const expiryMs = Date.parse(`${record.expiryDate}T00:00:00Z`);
    if (Number.isNaN(expiryMs)) {
      return false;
    }
    const daysUntilExpiry = Math.round((expiryMs - todayMs) / MS_PER_DAY);
    return daysUntilExpiry >= 0 && daysUntilExpiry <= leadDays;
  });
}
