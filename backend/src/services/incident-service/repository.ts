import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { captureAWSv3Client } from 'aws-xray-sdk-core';
import { assertNoDelimiter, buildDeptScopedPk } from '@boxalarm/dept-scope';
import type { VerifiedDeptId } from '@boxalarm/dept-scope';
import {
  buildNerisIncidentId,
  isIncidentStatus,
  type CreateIncidentInput,
  type Incident,
  type IncidentStatus,
} from './entity.js';

export interface IncidentRepository {
  createIncident(
    deptId: VerifiedDeptId,
    input: CreateIncidentInput,
    nowEpochSeconds: number,
  ): Promise<Incident>;
  getIncident(deptId: VerifiedDeptId, incidentId: string): Promise<Incident | undefined>;
}

export class DuplicateIncidentError extends Error {
  constructor(incidentId: string) {
    super(`incident with incidentId "${incidentId}" already exists`);
    this.name = 'DuplicateIncidentError';
  }
}

export class InvalidIncidentStatusError extends Error {
  constructor(status: string) {
    super(
      `status must be one of DRAFT, VALIDATED, SUBMITTED, ACCEPTED, REJECTED; received "${status}"`,
    );
    this.name = 'InvalidIncidentStatusError';
  }
}

let cachedClient: DynamoDBDocumentClient | undefined;

export function getDocumentClient(): DynamoDBDocumentClient {
  cachedClient ??= DynamoDBDocumentClient.from(captureAWSv3Client(new DynamoDBClient({})));
  return cachedClient;
}

export function getTableName(env: NodeJS.ProcessEnv): string {
  const tableName = env.INCIDENT_TABLE_NAME;
  if (!tableName) {
    throw new Error('INCIDENT_TABLE_NAME is required and was not set');
  }
  return tableName;
}

function toIncident(item: Record<string, unknown>): Incident {
  return {
    incidentId: item.incidentId as string,
    deptId: item.deptId as string,
    dispatchNumber: item.dispatchNumber as string,
    epochSeconds: item.epochSeconds as number,
    nerisSchemaVersion: item.nerisSchemaVersion as string,
    corePayload: item.corePayload as Readonly<Record<string, unknown>>,
    ...(typeof item.incidentType === 'string' ? { incidentType: item.incidentType } : {}),
    ...(typeof item.address === 'string' ? { address: item.address } : {}),
    ...(typeof item.latitude === 'number' ? { latitude: item.latitude } : {}),
    ...(typeof item.longitude === 'number' ? { longitude: item.longitude } : {}),
    ...(typeof item.alarmAt === 'number' ? { alarmAt: item.alarmAt } : {}),
    ...(typeof item.dispatchAt === 'number' ? { dispatchAt: item.dispatchAt } : {}),
    ...(typeof item.arrivedAt === 'number' ? { arrivedAt: item.arrivedAt } : {}),
    ...(typeof item.clearedAt === 'number' ? { clearedAt: item.clearedAt } : {}),
    ...(typeof item.narrative === 'string' ? { narrative: item.narrative } : {}),
    status: item.status as IncidentStatus,
    sourceDispatchId: item.sourceDispatchId as string,
    createdBy: item.createdBy as string,
    createdAt: item.createdAt as number,
    updatedAt: item.updatedAt as number,
  };
}

function resolveStatus(input: CreateIncidentInput): IncidentStatus {
  if (input.status === undefined) {
    return 'DRAFT';
  }
  if (!isIncidentStatus(input.status)) {
    throw new InvalidIncidentStatusError(String(input.status));
  }
  return input.status;
}

export function createIncidentRepository(
  client: DynamoDBDocumentClient,
  tableName: string,
): IncidentRepository {
  return {
    async createIncident(deptId, input, nowEpochSeconds) {
      assertNoDelimiter(input.dispatchNumber, 'dispatchNumber');
      const status = resolveStatus(input);
      const incidentId = buildNerisIncidentId(deptId, input.dispatchNumber, input.epochSeconds);
      const alarmAt = input.alarmAt ?? input.epochSeconds;
      const item = {
        pk: buildDeptScopedPk(deptId, 'INCIDENT', incidentId),
        sk: 'METADATA',
        entityType: 'INCIDENT',
        incidentId,
        deptId,
        dispatchNumber: input.dispatchNumber,
        epochSeconds: input.epochSeconds,
        nerisSchemaVersion: input.nerisSchemaVersion,
        corePayload: input.corePayload,
        ...(input.incidentType !== undefined ? { incidentType: input.incidentType } : {}),
        ...(input.address !== undefined ? { address: input.address } : {}),
        ...(input.latitude !== undefined ? { latitude: input.latitude } : {}),
        ...(input.longitude !== undefined ? { longitude: input.longitude } : {}),
        ...(input.alarmAt !== undefined ? { alarmAt: input.alarmAt } : {}),
        ...(input.dispatchAt !== undefined ? { dispatchAt: input.dispatchAt } : {}),
        ...(input.arrivedAt !== undefined ? { arrivedAt: input.arrivedAt } : {}),
        ...(input.clearedAt !== undefined ? { clearedAt: input.clearedAt } : {}),
        ...(input.narrative !== undefined ? { narrative: input.narrative } : {}),
        status,
        sourceDispatchId: incidentId,
        createdBy: input.createdBy,
        createdAt: nowEpochSeconds,
        updatedAt: nowEpochSeconds,
        gsi1pk: buildDeptScopedPk(deptId),
        gsi1sk: `INCIDENT#${alarmAt}`,
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
          throw new DuplicateIncidentError(incidentId);
        }
        throw error;
      }
      return toIncident(item);
    },

    async getIncident(deptId, incidentId) {
      const result = await client.send(
        new GetCommand({
          TableName: tableName,
          Key: {
            pk: buildDeptScopedPk(deptId, 'INCIDENT', incidentId),
            sk: 'METADATA',
          },
        }),
      );
      return result.Item ? toIncident(result.Item as Record<string, unknown>) : undefined;
    },
  };
}

let cachedRepository: IncidentRepository | undefined;

export function getIncidentRepository(env: NodeJS.ProcessEnv): IncidentRepository {
  cachedRepository ??= createIncidentRepository(getDocumentClient(), getTableName(env));
  return cachedRepository;
}
