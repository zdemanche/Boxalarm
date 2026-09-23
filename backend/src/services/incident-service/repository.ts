import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { captureAWSv3Client } from 'aws-xray-sdk-core';
import { assertNoDelimiter, buildDeptScopedPk } from '@boxalarm/dept-scope';
import type { VerifiedDeptId } from '@boxalarm/dept-scope';
import { buildOutboxRecord } from '@boxalarm/outbox';
import {
  buildNerisIncidentId,
  isIncidentStatus,
  type CreateIncidentInput,
  type Incident,
  type IncidentStatus,
} from './entity.js';

export interface SearchIncidentsInput {
  readonly fromAlarmAt: number;
  readonly toAlarmAt: number;
}

export interface IncidentRepository {
  createIncident(
    deptId: VerifiedDeptId,
    input: CreateIncidentInput,
    nowEpochSeconds: number,
    traceId: string,
  ): Promise<Incident>;
  getIncident(deptId: VerifiedDeptId, incidentId: string): Promise<Incident | undefined>;
  updateNarrative(
    deptId: VerifiedDeptId,
    incidentId: string,
    narrative: string,
    nowEpochSeconds: number,
  ): Promise<Incident>;
  updateCorePayload(
    deptId: VerifiedDeptId,
    incidentId: string,
    corePayload: Readonly<Record<string, unknown>>,
    status: IncidentStatus,
    nowEpochSeconds: number,
  ): Promise<Incident>;
  searchIncidents(
    deptId: VerifiedDeptId,
    input: SearchIncidentsInput,
  ): Promise<readonly Incident[]>;
}

export class IncidentNotFoundError extends Error {
  constructor(incidentId: string) {
    super(`no incident found with incidentId "${incidentId}"`);
    this.name = 'IncidentNotFoundError';
  }
}

export const MAX_NARRATIVE_LENGTH = 25_000;

export class NarrativeTooLongError extends Error {
  constructor(length: number) {
    super(`narrative must not exceed ${MAX_NARRATIVE_LENGTH} characters; received ${length}`);
    this.name = 'NarrativeTooLongError';
  }
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
    async createIncident(deptId, input, nowEpochSeconds, traceId) {
      assertNoDelimiter(input.dispatchNumber, 'dispatchNumber');
      const status = resolveStatus(input);
      const incidentId =
        input.incidentId ?? buildNerisIncidentId(deptId, input.dispatchNumber, input.epochSeconds);
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

      // Audit entry shape matches the sibling create-path precedent (memberRepository.ts's
      // createMember, equipmentRepository.ts's writeAuditLogEntry): a durable AUDIT_LOG_ENTRY
      // row co-located in this service's own table so it commits atomically with the entity.
      const auditTs = Date.now();
      const auditDate = new Date(auditTs).toISOString().slice(0, 10);
      const auditItem = {
        pk: buildDeptScopedPk(deptId, 'AUDIT', auditDate),
        sk: `${auditTs}#INCIDENT#${incidentId}#${input.createdBy}`,
        entityType: 'AUDIT_LOG_ENTRY',
        mutatedEntityType: 'INCIDENT',
        mutatedEntityId: incidentId,
        action: 'CREATE',
        actorId: input.createdBy,
        changedFields: {
          status: { old: null, new: status },
          dispatchNumber: { old: null, new: input.dispatchNumber },
        },
        ts: auditTs,
        gsi3pk: buildDeptScopedPk(deptId, 'AUDIT', 'ENTITY', 'INCIDENT', incidentId),
        gsi3sk: String(auditTs),
      };

      // Lean payload (not the full corePayload) keeps the outbox item well under the
      // per-item DynamoDB limit and matches the sibling outbox precedent (defectRepository.ts,
      // hydrantRepository.ts) of publishing identifiers/summary fields, not the full entity.
      const outboxRecord = buildOutboxRecord(
        deptId,
        'incident-service',
        'incident.created',
        traceId,
        {
          incidentId,
          deptId,
          dispatchNumber: input.dispatchNumber,
          status,
          createdBy: input.createdBy,
        },
      );

      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: tableName,
                  Item: item,
                  ConditionExpression: 'attribute_not_exists(pk)',
                },
              },
              { Put: { TableName: tableName, Item: auditItem } },
              { Put: { TableName: tableName, Item: outboxRecord } },
            ],
          }),
        );
      } catch (error) {
        if (
          error instanceof TransactionCanceledException &&
          error.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed'
        ) {
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

    async updateNarrative(deptId, incidentId, narrative, nowEpochSeconds) {
      if (narrative.length > MAX_NARRATIVE_LENGTH) {
        throw new NarrativeTooLongError(narrative.length);
      }
      try {
        const result = await client.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { pk: buildDeptScopedPk(deptId, 'INCIDENT', incidentId), sk: 'METADATA' },
            ConditionExpression: 'attribute_exists(pk)',
            UpdateExpression:
              'SET narrative = :narrative, corePayload.narrative = :narrative, updatedAt = :updatedAt',
            ExpressionAttributeValues: { ':narrative': narrative, ':updatedAt': nowEpochSeconds },
            ReturnValues: 'ALL_NEW',
          }),
        );
        return toIncident(result.Attributes as Record<string, unknown>);
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) {
          throw new IncidentNotFoundError(incidentId);
        }
        throw error;
      }
    },

    async updateCorePayload(deptId, incidentId, corePayload, status, nowEpochSeconds) {
      try {
        const result = await client.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { pk: buildDeptScopedPk(deptId, 'INCIDENT', incidentId), sk: 'METADATA' },
            ConditionExpression: 'attribute_exists(pk)',
            UpdateExpression:
              'SET corePayload = :corePayload, #status = :status, updatedAt = :updatedAt',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':corePayload': corePayload,
              ':status': status,
              ':updatedAt': nowEpochSeconds,
            },
            ReturnValues: 'ALL_NEW',
          }),
        );
        return toIncident(result.Attributes as Record<string, unknown>);
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) {
          throw new IncidentNotFoundError(incidentId);
        }
        throw error;
      }
    },

    async searchIncidents(deptId, input) {
      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: 'GSI1',
          KeyConditionExpression: 'gsi1pk = :pk AND gsi1sk BETWEEN :from AND :to',
          ExpressionAttributeValues: {
            ':pk': buildDeptScopedPk(deptId),
            ':from': `INCIDENT#${input.fromAlarmAt}`,
            ':to': `INCIDENT#${input.toAlarmAt}`,
          },
        }),
      );
      return (result.Items ?? []).map((item) => toIncident(item as Record<string, unknown>));
    },
  };
}

let cachedRepository: IncidentRepository | undefined;

export function getIncidentRepository(env: NodeJS.ProcessEnv): IncidentRepository {
  cachedRepository ??= createIncidentRepository(getDocumentClient(), getTableName(env));
  return cachedRepository;
}
