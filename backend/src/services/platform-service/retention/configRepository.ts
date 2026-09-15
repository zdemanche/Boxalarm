import { GetCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

export const DEFAULT_RETENTION_YEARS = 7;
export const RETENTION_SK = 'CONFIG#RETENTION';
export const RETENTION_CONFIG_TYPE = 'RETENTION';

export interface RetentionConfigValue {
  readonly retentionYears: number;
}

export interface RetentionConfigRecord {
  readonly pk: string;
  readonly sk: typeof RETENTION_SK;
  readonly entityType: 'DEPARTMENT_CONFIG';
  readonly configType: typeof RETENTION_CONFIG_TYPE;
  readonly value: RetentionConfigValue;
  readonly version: number;
}

export interface RetentionConfigRead {
  readonly retentionYears: number;
  readonly version: number | undefined;
  readonly source: 'stored' | 'default';
}

export interface PutRetentionConfigInput {
  readonly deptId: VerifiedDeptId;
  readonly retentionYears: number;
  readonly actorId: string;
}

function readTableName(): string {
  const tableName = process.env.PLATFORM_TABLE_NAME;
  if (!tableName) {
    throw new Error('PLATFORM_TABLE_NAME is required and was not set');
  }
  return tableName;
}

function verifiedDeptIdFromRetentionPk(pk: string): VerifiedDeptId {
  const match = /^DEPT#([^#]+)$/.exec(pk);
  if (!match?.[1]) {
    throw new Error('malformed DEPARTMENT_CONFIG RETENTION pk');
  }
  return match[1] as VerifiedDeptId;
}

function parseStoredItem(item: Record<string, unknown>): RetentionConfigRecord {
  const value = item.value as RetentionConfigValue | undefined;
  if (
    item.entityType !== 'DEPARTMENT_CONFIG' ||
    item.configType !== RETENTION_CONFIG_TYPE ||
    item.sk !== RETENTION_SK ||
    typeof item.pk !== 'string' ||
    typeof item.version !== 'number' ||
    !value ||
    typeof value.retentionYears !== 'number'
  ) {
    throw new Error('malformed DEPARTMENT_CONFIG RETENTION item');
  }
  const deptId = verifiedDeptIdFromRetentionPk(item.pk);
  return {
    pk: buildDeptScopedPk(deptId),
    sk: RETENTION_SK,
    entityType: 'DEPARTMENT_CONFIG',
    configType: RETENTION_CONFIG_TYPE,
    value: { retentionYears: value.retentionYears },
    version: item.version,
  };
}

export async function getRetentionConfig(
  client: DynamoDBDocumentClient,
  deptId: VerifiedDeptId,
): Promise<RetentionConfigRead> {
  const result = await client.send(
    new GetCommand({
      TableName: readTableName(),
      Key: { pk: buildDeptScopedPk(deptId), sk: RETENTION_SK },
    }),
  );
  if (!result.Item) {
    return {
      retentionYears: DEFAULT_RETENTION_YEARS,
      version: undefined,
      source: 'default',
    };
  }
  const stored = parseStoredItem(result.Item);
  return {
    retentionYears: stored.value.retentionYears,
    version: stored.version,
    source: 'stored',
  };
}

export async function putRetentionConfig(
  client: DynamoDBDocumentClient,
  input: PutRetentionConfigInput,
): Promise<RetentionConfigRecord> {
  const tableName = readTableName();
  const existing = await client.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: buildDeptScopedPk(input.deptId), sk: RETENTION_SK },
    }),
  );
  const nextVersion =
    existing.Item && typeof existing.Item.version === 'number' ? existing.Item.version + 1 : 1;

  const item: RetentionConfigRecord = {
    pk: buildDeptScopedPk(input.deptId),
    sk: RETENTION_SK,
    entityType: 'DEPARTMENT_CONFIG',
    configType: RETENTION_CONFIG_TYPE,
    value: { retentionYears: input.retentionYears },
    version: nextVersion,
  };

  await client.send(
    new PutCommand({
      TableName: tableName,
      Item: item,
    }),
  );

  return item;
}
