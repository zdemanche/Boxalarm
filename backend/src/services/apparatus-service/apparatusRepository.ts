import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { captureAWSv3Client } from 'aws-xray-sdk-core';
import { buildDeptScopedPk } from '@boxalarm/dept-scope';
import type { VerifiedDeptId } from '@boxalarm/dept-scope';

export type ApparatusStatus = 'IN_SERVICE' | 'OUT_OF_SERVICE';

export interface Apparatus {
  readonly apparatusId: string;
  readonly unitId: string;
  readonly type: string;
  readonly status: ApparatusStatus;
}

export interface CreateApparatusInput {
  readonly unitId: string;
  readonly type: string;
  readonly status: ApparatusStatus;
}

export interface ApparatusRepository {
  listApparatus(deptId: VerifiedDeptId): Promise<readonly Apparatus[]>;
  getApparatusByUnitId(deptId: VerifiedDeptId, unitId: string): Promise<Apparatus | undefined>;
  createApparatus(deptId: VerifiedDeptId, input: CreateApparatusInput): Promise<Apparatus>;
}

export class DuplicateApparatusError extends Error {
  constructor(unitId: string) {
    super(`apparatus with unitId "${unitId}" already exists`);
    this.name = 'DuplicateApparatusError';
  }
}

export const GSI3_INDEX_NAME = 'GSI3';

let cachedClient: DynamoDBDocumentClient | undefined;

export function getDocumentClient(): DynamoDBDocumentClient {
  cachedClient ??= DynamoDBDocumentClient.from(captureAWSv3Client(new DynamoDBClient({})));
  return cachedClient;
}

export function getTableName(env: NodeJS.ProcessEnv): string {
  const tableName = env.PLATFORM_TABLE_NAME;
  if (!tableName) {
    throw new Error('PLATFORM_TABLE_NAME is required and was not set');
  }
  return tableName;
}

function toApparatusId(unitId: string): string {
  return `APP-${unitId}`;
}

function toApparatus(item: Record<string, unknown>): Apparatus {
  return {
    apparatusId: item.apparatusId as string,
    unitId: item.unitId as string,
    type: item.type as string,
    status: item.status as ApparatusStatus,
  };
}

export function createApparatusRepository(
  client: DynamoDBDocumentClient,
  tableName: string,
): ApparatusRepository {
  return {
    async listApparatus(deptId) {
      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: GSI3_INDEX_NAME,
          KeyConditionExpression: 'gsi3pk = :gsi3pk',
          ExpressionAttributeValues: { ':gsi3pk': buildDeptScopedPk(deptId, 'APPARATUS') },
        }),
      );
      return (result.Items ?? []).map(toApparatus);
    },

    async getApparatusByUnitId(deptId, unitId) {
      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: GSI3_INDEX_NAME,
          KeyConditionExpression: 'gsi3pk = :gsi3pk AND gsi3sk = :gsi3sk',
          ExpressionAttributeValues: {
            ':gsi3pk': buildDeptScopedPk(deptId, 'APPARATUS'),
            ':gsi3sk': unitId,
          },
        }),
      );
      const item = result.Items?.[0];
      return item ? toApparatus(item) : undefined;
    },

    async createApparatus(deptId, input) {
      const apparatusId = toApparatusId(input.unitId);
      const item = {
        pk: buildDeptScopedPk(deptId, 'APPARATUS', apparatusId),
        sk: 'METADATA',
        entityType: 'APPARATUS',
        apparatusId,
        unitId: input.unitId,
        type: input.type,
        status: input.status,
        gsi3pk: buildDeptScopedPk(deptId, 'APPARATUS'),
        gsi3sk: input.unitId,
      };
      try {
        await client.send(
          new PutCommand({
            TableName: tableName,
            Item: item,
            ConditionExpression: 'attribute_not_exists(pk)',
          }),
        );
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) {
          throw new DuplicateApparatusError(input.unitId);
        }
        throw error;
      }
      return toApparatus(item);
    },
  };
}

let cachedRepository: ApparatusRepository | undefined;

export function getApparatusRepository(env: NodeJS.ProcessEnv): ApparatusRepository {
  cachedRepository ??= createApparatusRepository(getDocumentClient(), getTableName(env));
  return cachedRepository;
}
