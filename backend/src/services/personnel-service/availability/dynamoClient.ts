import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import AWSXRay from 'aws-xray-sdk-core';

export interface PersonnelDdbConfig {
  readonly tableName: string;
}

export function readPersonnelDdbConfig(env: NodeJS.ProcessEnv): PersonnelDdbConfig {
  const tableName = env.PLATFORM_TABLE_NAME;
  if (!tableName) {
    throw new Error('PLATFORM_TABLE_NAME is required and was not set');
  }
  return { tableName };
}

let cachedClient: DynamoDBDocumentClient | undefined;

export function createDdbClient(
  env: NodeJS.ProcessEnv,
  client?: DynamoDBDocumentClient,
): DynamoDBDocumentClient {
  readPersonnelDdbConfig(env);
  cachedClient ??=
    client ?? DynamoDBDocumentClient.from(AWSXRay.captureAWSv3Client(new DynamoDBClient({})));
  return cachedClient;
}

export type AvailabilityMarkoffItem = Record<'pk' | 'sk', string> & {
  readonly entityType: 'AVAILABILITY_MARKOFF';
  readonly memberId: string;
  readonly deptId: string;
  readonly startAt: number;
  readonly endAt: number;
  readonly reason?: string;
  readonly affectsAlerting: boolean;
  readonly activatedAt?: number;
  readonly revertedAt?: number;
};

export function parseMarkoffItem(
  item: Record<string, unknown> | undefined,
): AvailabilityMarkoffItem | undefined {
  if (!item) {
    return undefined;
  }
  const {
    pk,
    sk,
    entityType,
    memberId,
    deptId,
    startAt,
    endAt,
    reason,
    affectsAlerting,
    activatedAt,
    revertedAt,
  } = item;
  if (
    typeof pk !== 'string' ||
    typeof sk !== 'string' ||
    entityType !== 'AVAILABILITY_MARKOFF' ||
    typeof memberId !== 'string' ||
    typeof deptId !== 'string' ||
    typeof startAt !== 'number' ||
    typeof endAt !== 'number' ||
    typeof affectsAlerting !== 'boolean'
  ) {
    throw new Error('AVAILABILITY_MARKOFF item failed shape validation');
  }
  return {
    pk,
    sk,
    entityType,
    memberId,
    deptId,
    startAt,
    endAt,
    affectsAlerting,
    ...(typeof reason === 'string' ? { reason } : {}),
    ...(typeof activatedAt === 'number' ? { activatedAt } : {}),
    ...(typeof revertedAt === 'number' ? { revertedAt } : {}),
  };
}
