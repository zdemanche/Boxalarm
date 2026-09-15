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

export interface OpenDefectSummary {
  readonly defectId: string;
  readonly description: string;
  readonly severity: string;
  readonly reportedAt: number;
}

export interface FailedTestSummary {
  readonly testType: string;
  readonly testDate: string;
  readonly nextDueDate: string;
}

export interface ApparatusDetail extends Apparatus {
  readonly openDefects: readonly OpenDefectSummary[];
  readonly failedTests: readonly FailedTestSummary[];
}

export interface ApparatusRepository {
  listApparatus(deptId: VerifiedDeptId): Promise<readonly Apparatus[]>;
  getApparatusByUnitId(deptId: VerifiedDeptId, unitId: string): Promise<Apparatus | undefined>;
  createApparatus(deptId: VerifiedDeptId, input: CreateApparatusInput): Promise<Apparatus>;
  getApparatusDetail(deptId: VerifiedDeptId, unitId: string): Promise<ApparatusDetail | undefined>;
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

function toOpenDefectSummary(item: Record<string, unknown>): OpenDefectSummary {
  return {
    defectId: item.defectId as string,
    description: item.description as string,
    severity: item.severity as string,
    reportedAt: item.reportedAt as number,
  };
}

function latestFailedTestsPerType(
  items: readonly Record<string, unknown>[],
): readonly FailedTestSummary[] {
  const seenTestTypes = new Set<string>();
  const failedTests: FailedTestSummary[] = [];
  for (const item of items) {
    const testType = item.testType as string;
    if (seenTestTypes.has(testType)) {
      continue;
    }
    seenTestTypes.add(testType);
    if (item.result === 'FAIL') {
      failedTests.push({
        testType,
        testDate: item.testDate as string,
        nextDueDate: item.nextDueDate as string,
      });
    }
  }
  return failedTests;
}

export function createApparatusRepository(
  client: DynamoDBDocumentClient,
  tableName: string,
): ApparatusRepository {
  const repository: ApparatusRepository = {
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

    async getApparatusDetail(deptId, unitId) {
      const apparatus = await repository.getApparatusByUnitId(deptId, unitId);
      if (!apparatus) {
        return undefined;
      }
      const [defectsResult, testsResult] = await Promise.all([
        client.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
            FilterExpression: '#status = :open',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':pk': buildDeptScopedPk(deptId, 'APPARATUS', apparatus.apparatusId),
              ':prefix': 'DEFECT#',
              ':open': 'OPEN',
            },
          }),
        ),
        client.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
            ExpressionAttributeValues: {
              ':pk': buildDeptScopedPk(deptId, 'APPARATUS', apparatus.apparatusId),
              ':prefix': 'TEST#',
            },
            ScanIndexForward: false,
          }),
        ),
      ]);

      return {
        ...apparatus,
        openDefects: (defectsResult.Items ?? []).map(toOpenDefectSummary),
        failedTests: latestFailedTestsPerType(testsResult.Items ?? []),
      };
    },
  };
  return repository;
}

let cachedRepository: ApparatusRepository | undefined;

export function getApparatusRepository(env: NodeJS.ProcessEnv): ApparatusRepository {
  cachedRepository ??= createApparatusRepository(getDocumentClient(), getTableName(env));
  return cachedRepository;
}
