import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

export const DEPARTMENT_CONFIG_TYPES = [
  'STATIONS',
  'RANKS',
  'LOSAP_POINT_RULES',
  'ALERT_RULES',
  'CHECKLIST_DEFAULTS',
  'RETENTION',
] as const;

export type DepartmentConfigType = (typeof DEPARTMENT_CONFIG_TYPES)[number];

export function isDepartmentConfigType(value: string): value is DepartmentConfigType {
  return (DEPARTMENT_CONFIG_TYPES as readonly string[]).includes(value);
}

export interface DepartmentConfigItem {
  readonly pk: string;
  readonly sk: string;
  readonly entityType: 'DEPARTMENT_CONFIG';
  readonly configType: DepartmentConfigType;
  readonly value: Record<string, unknown>;
  readonly version: number;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export class ConflictError extends Error {
  constructor(message = 'department config version conflict') {
    super(message);
    this.name = 'ConflictError';
  }
}

export function configSk(configType: DepartmentConfigType): string {
  return `CONFIG#${configType}`;
}

export interface GetDepartmentConfigInput {
  readonly tableName: string;
  readonly deptId: VerifiedDeptId;
  readonly configType: DepartmentConfigType;
}

export async function getDepartmentConfig(
  docClient: DynamoDBDocumentClient,
  input: GetDepartmentConfigInput,
): Promise<DepartmentConfigItem | undefined> {
  const result = await docClient.send(
    new GetCommand({
      TableName: input.tableName,
      Key: {
        pk: buildDeptScopedPk(input.deptId),
        sk: configSk(input.configType),
      },
    }),
  );
  return result.Item as DepartmentConfigItem | undefined;
}

export interface PutDepartmentConfigInput {
  readonly tableName: string;
  readonly deptId: VerifiedDeptId;
  readonly configType: DepartmentConfigType;
  readonly value: Record<string, unknown>;
  readonly actorId: string;
  readonly expectedVersion?: number;
  readonly now?: () => Date;
}

export async function putDepartmentConfig(
  docClient: DynamoDBDocumentClient,
  input: PutDepartmentConfigInput,
): Promise<DepartmentConfigItem> {
  const now = (input.now ?? (() => new Date()))().toISOString();
  const nextVersion = (input.expectedVersion ?? 0) + 1;
  const item: DepartmentConfigItem = {
    pk: buildDeptScopedPk(input.deptId),
    sk: configSk(input.configType),
    entityType: 'DEPARTMENT_CONFIG',
    configType: input.configType,
    value: input.value,
    version: nextVersion,
    updatedAt: now,
    updatedBy: input.actorId,
  };

  const isCreate = input.expectedVersion === undefined;
  try {
    await docClient.send(
      new PutCommand({
        TableName: input.tableName,
        Item: item,
        ConditionExpression: isCreate
          ? 'attribute_not_exists(pk) AND attribute_not_exists(sk)'
          : 'attribute_exists(pk) AND attribute_exists(sk) AND #version = :expectedVersion',
        ExpressionAttributeNames: isCreate ? undefined : { '#version': 'version' },
        ExpressionAttributeValues: isCreate
          ? undefined
          : { ':expectedVersion': input.expectedVersion },
      }),
    );
  } catch (error) {
    if (
      error instanceof ConditionalCheckFailedException ||
      (error instanceof Error && error.name === 'ConditionalCheckFailedException')
    ) {
      throw new ConflictError();
    }
    throw error;
  }

  return item;
}
