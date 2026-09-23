import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { captureAWSv3Client } from 'aws-xray-sdk-core';
import geohash from 'ngeohash';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import type { VerifiedPrincipal } from '@boxalarm/dept-scope';
import { logStructuredError } from './log.js';
import type { OccupancyServiceConfig } from './config.js';
import type { CreateOccupancyInput, OccupancyContact, UpdateOccupancyInput } from './validation.js';

export class OccupancyNotFoundError extends Error {}

const OCCUPANCY_SK = 'METADATA';
const GEOHASH5_PRECISION = 5;
const GEOHASH8_PRECISION = 8;

export interface OccupancyRecord {
  readonly occupancyId: string;
  readonly address: string;
  readonly normalizedAddress: string;
  readonly occupancyType: string;
  readonly contacts: readonly OccupancyContact[];
  readonly hazards: readonly string[];
  readonly latitude?: number;
  readonly longitude?: number;
}

let cachedDocumentClient: DynamoDBDocumentClient | undefined;

function getDocumentClient(): DynamoDBDocumentClient {
  cachedDocumentClient ??= DynamoDBDocumentClient.from(captureAWSv3Client(new DynamoDBClient({})));
  return cachedDocumentClient;
}

function itemToRecord(item: Record<string, unknown>): OccupancyRecord {
  return {
    occupancyId: item.occupancyId as string,
    address: item.address as string,
    normalizedAddress: item.normalizedAddress as string,
    occupancyType: item.occupancyType as string,
    contacts: item.contacts as readonly OccupancyContact[],
    hazards: item.hazards as readonly string[],
    ...(typeof item.latitude === 'number' ? { latitude: item.latitude } : {}),
    ...(typeof item.longitude === 'number' ? { longitude: item.longitude } : {}),
  };
}

export async function getOccupancyById(
  config: OccupancyServiceConfig,
  principal: VerifiedPrincipal,
  occupancyId: string,
): Promise<OccupancyRecord | undefined> {
  const deptId = toVerifiedDeptId(principal);
  const client = getDocumentClient();
  const result = await client.send(
    new GetCommand({
      TableName: config.tableName,
      Key: { pk: buildDeptScopedPk(deptId, 'OCCUPANCY', occupancyId), sk: OCCUPANCY_SK },
    }),
  );
  return result.Item ? itemToRecord(result.Item) : undefined;
}

function buildAuditItem(
  deptId: ReturnType<typeof toVerifiedDeptId>,
  occupancyId: string,
  action: 'CREATE' | 'UPDATE',
  actorId: string,
  changedFields: Record<string, { old: unknown; new: unknown }>,
): Record<string, unknown> {
  const ts = Date.now();
  const date = new Date(ts).toISOString().slice(0, 10);
  return {
    pk: buildDeptScopedPk(deptId, 'AUDIT', date),
    sk: `${ts}#OCCUPANCY#${occupancyId}#${actorId}`,
    entityType: 'AUDIT_LOG_ENTRY',
    mutatedEntityType: 'OCCUPANCY',
    mutatedEntityId: occupancyId,
    action,
    actorId,
    changedFields,
    ts,
    gsi3pk: buildDeptScopedPk(deptId, 'AUDIT', 'ENTITY', 'OCCUPANCY', occupancyId),
    gsi3sk: `${ts}`,
  };
}

export async function createOccupancy(
  config: OccupancyServiceConfig,
  principal: VerifiedPrincipal,
  occupancyId: string,
  input: CreateOccupancyInput,
  actorId: string,
  traceId: string,
): Promise<OccupancyRecord> {
  const deptId = toVerifiedDeptId(principal);
  const client = getDocumentClient();

  const hasCoordinates = input.latitude !== undefined && input.longitude !== undefined;
  let geo: { readonly gsi3pk: string; readonly gsi3sk: string } | undefined;
  if (hasCoordinates) {
    const geohash8 = geohash.encode(input.latitude, input.longitude, GEOHASH8_PRECISION);
    const geohash5 = geohash8.slice(0, GEOHASH5_PRECISION);
    geo = {
      gsi3pk: buildDeptScopedPk(deptId, 'OCCUPANCY', 'GEO', geohash5),
      gsi3sk: `${geohash8}#${occupancyId}`,
    };
  }

  const item = {
    pk: buildDeptScopedPk(deptId, 'OCCUPANCY', occupancyId),
    sk: OCCUPANCY_SK,
    entityType: 'OCCUPANCY',
    occupancyId,
    address: input.address,
    normalizedAddress: input.normalizedAddress,
    occupancyType: input.occupancyType,
    contacts: input.contacts,
    hazards: input.hazards,
    ...(input.latitude !== undefined ? { latitude: input.latitude } : {}),
    ...(input.longitude !== undefined ? { longitude: input.longitude } : {}),
    ...(geo ?? {}),
  };

  const addressIndexItem = {
    pk: buildDeptScopedPk(deptId, 'OCCUPANCY', occupancyId),
    sk: `ADDR#${input.normalizedAddress}`,
    entityType: 'OCCUPANCY_ADDRESS_INDEX',
    occupancyId,
    gsi3pk: buildDeptScopedPk(deptId, 'OCCUPANCY', 'ADDR', input.normalizedAddress),
    gsi3sk: occupancyId,
  };

  const auditItem = buildAuditItem(deptId, occupancyId, 'CREATE', actorId, {
    address: { old: null, new: input.address },
    occupancyType: { old: null, new: input.occupancyType },
    contacts: { old: null, new: input.contacts },
    hazards: { old: null, new: input.hazards },
  });

  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: config.tableName,
              Item: item,
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          { Put: { TableName: config.tableName, Item: addressIndexItem } },
          { Put: { TableName: config.tableName, Item: auditItem } },
        ],
      }),
    );
  } catch (error) {
    logStructuredError('occupancy.create.failed', traceId, {
      occupancyId,
      message: error instanceof Error ? error.message : undefined,
      cancellationReasons:
        error instanceof TransactionCanceledException ? error.CancellationReasons : undefined,
    });
    throw error;
  }

  return itemToRecord(item);
}

function isConditionalCheckFailure(error: unknown): boolean {
  return (
    error instanceof TransactionCanceledException &&
    (error.CancellationReasons ?? []).some((reason) => reason.Code === 'ConditionalCheckFailed')
  );
}

export async function updateOccupancy(
  config: OccupancyServiceConfig,
  principal: VerifiedPrincipal,
  occupancyId: string,
  existing: OccupancyRecord,
  input: UpdateOccupancyInput,
  actorId: string,
  traceId: string,
): Promise<OccupancyRecord> {
  const deptId = toVerifiedDeptId(principal);
  const client = getDocumentClient();

  const changedFields: Record<string, { old: unknown; new: unknown }> = {};
  const updateNames: Record<string, string> = {};
  const updateValues: Record<string, unknown> = {};
  const setClauses: string[] = [];

  if (input.contacts !== undefined) {
    changedFields.contacts = { old: existing.contacts, new: input.contacts };
    updateNames['#contacts'] = 'contacts';
    updateValues[':contacts'] = input.contacts;
    setClauses.push('#contacts = :contacts');
  }
  if (input.hazards !== undefined) {
    changedFields.hazards = { old: existing.hazards, new: input.hazards };
    updateNames['#hazards'] = 'hazards';
    updateValues[':hazards'] = input.hazards;
    setClauses.push('#hazards = :hazards');
  }

  const auditItem = buildAuditItem(deptId, occupancyId, 'UPDATE', actorId, changedFields);

  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: config.tableName,
              Key: { pk: buildDeptScopedPk(deptId, 'OCCUPANCY', occupancyId), sk: OCCUPANCY_SK },
              ConditionExpression: 'attribute_exists(pk)',
              UpdateExpression: `SET ${setClauses.join(', ')}`,
              ExpressionAttributeNames: updateNames,
              ExpressionAttributeValues: updateValues,
            },
          },
          { Put: { TableName: config.tableName, Item: auditItem } },
        ],
      }),
    );
  } catch (error) {
    logStructuredError('occupancy.update.failed', traceId, {
      occupancyId,
      message: error instanceof Error ? error.message : undefined,
      cancellationReasons:
        error instanceof TransactionCanceledException ? error.CancellationReasons : undefined,
    });
    if (isConditionalCheckFailure(error)) {
      throw new OccupancyNotFoundError(occupancyId);
    }
    throw error;
  }

  return {
    ...existing,
    ...(input.contacts !== undefined ? { contacts: input.contacts } : {}),
    ...(input.hazards !== undefined ? { hazards: input.hazards } : {}),
  };
}
