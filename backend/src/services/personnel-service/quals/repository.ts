import { randomUUID } from 'node:crypto';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { deriveCurrentlyEligible, type CertStatus } from './eligibility.js';

export interface MemberQualification {
  readonly qualCode: string;
  readonly grantedByCertId: string | null;
  readonly currentlyEligible: boolean;
}

export interface EligibilityChangedPayload {
  readonly deptId: string;
  readonly memberId: string;
  readonly qualCode: string;
  readonly currentlyEligible: boolean;
  readonly grantedByCertId: string | null;
}

const EVENT_TYPE = 'personnel.eligibility.changed';
const EVENT_SOURCE = 'personnel-service';
const SCHEMA_VERSION = '1.0';

export class CertNotFoundError extends Error {
  constructor(readonly certId: string) {
    super(`Certification ${certId} not found`);
    this.name = 'CertNotFoundError';
  }
}

function logRepositoryError(event: string, error: unknown, context: Record<string, unknown>): void {
  console.error(
    JSON.stringify({
      event,
      service: 'personnel-service',
      ...context,
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      message: error instanceof Error ? error.message : undefined,
      cancellationReasons:
        error instanceof TransactionCanceledException ? error.CancellationReasons : undefined,
    }),
  );
}

function buildOutboxEnvelope(correlationId: string, payload: EligibilityChangedPayload) {
  return {
    entityType: 'OUTBOX' as const,
    eventType: EVENT_TYPE,
    sent: false,
    envelope: {
      eventId: randomUUID(),
      eventTime: new Date().toISOString(),
      eventType: EVENT_TYPE,
      source: EVENT_SOURCE,
      correlationId,
      schemaVersion: SCHEMA_VERSION,
      payload,
    },
  };
}

export async function memberExists(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  memberId: string,
): Promise<boolean> {
  const pk = buildDeptScopedPk(deptId, 'MEMBER', memberId);
  try {
    const result = await client.send(
      new GetCommand({ TableName: tableName, Key: { pk, sk: 'METADATA' } }),
    );
    return result.Item !== undefined;
  } catch (error) {
    logRepositoryError('personnel.quals.memberExists.failed', error, { deptId, memberId });
    throw error;
  }
}

export async function readQuals(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  memberId: string,
): Promise<readonly MemberQualification[]> {
  const pk = buildDeptScopedPk(deptId, 'MEMBER', memberId);
  const items: Record<string, unknown>[] = [];
  try {
    let lastEvaluatedKey: Record<string, unknown> | undefined;
    do {
      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'pk = :pkVal AND begins_with(sk, :skPrefix)',
          ExpressionAttributeValues: { ':pkVal': pk, ':skPrefix': 'QUAL#' },
          ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
        }),
      );
      items.push(...(result.Items ?? []));
      lastEvaluatedKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastEvaluatedKey);
  } catch (error) {
    logRepositoryError('personnel.quals.read.failed', error, { deptId, memberId });
    throw error;
  }
  return items.map((item) => ({
    qualCode: item.qualCode as string,
    grantedByCertId: (item.grantedByCertId as string | null | undefined) ?? null,
    currentlyEligible: item.currentlyEligible as boolean,
  }));
}

async function readCertStatus(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  memberId: string,
  certId: string,
): Promise<CertStatus> {
  const pk = buildDeptScopedPk(deptId, 'MEMBER', memberId);
  try {
    const result = await client.send(
      new GetCommand({ TableName: tableName, Key: { pk, sk: `CERT#${certId}` } }),
    );
    if (!result.Item) {
      throw new CertNotFoundError(certId);
    }
    return result.Item.status as CertStatus;
  } catch (error) {
    if (error instanceof CertNotFoundError) {
      throw error;
    }
    logRepositoryError('personnel.quals.certLookup.failed', error, { deptId, memberId, certId });
    throw error;
  }
}

export async function putQual(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  memberId: string,
  qualCode: string,
  grantedByCertId: string | null,
  correlationId: string,
): Promise<MemberQualification> {
  const pk = buildDeptScopedPk(deptId, 'MEMBER', memberId);
  const certStatus =
    grantedByCertId === null
      ? undefined
      : await readCertStatus(client, tableName, deptId, memberId, grantedByCertId);
  const currentlyEligible = deriveCurrentlyEligible(grantedByCertId, certStatus);
  const qualItem = {
    pk,
    sk: `QUAL#${qualCode}`,
    entityType: 'MEMBER_QUALIFICATION',
    qualCode,
    grantedByCertId,
    currentlyEligible,
    gsi1pk: buildDeptScopedPk(deptId, 'MEMBER', memberId),
    gsi1sk: `MEMBER_QUALIFICATION#${qualCode}`,
  };
  const outboxItem = {
    pk,
    sk: `OUTBOX#${randomUUID()}`,
    ...buildOutboxEnvelope(correlationId, {
      deptId,
      memberId,
      qualCode,
      currentlyEligible,
      grantedByCertId,
    }),
  };

  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: tableName, Item: qualItem } },
          { Put: { TableName: tableName, Item: outboxItem } },
        ],
      }),
    );
  } catch (error) {
    logRepositoryError('personnel.quals.write.failed', error, { deptId, memberId, qualCode });
    throw error;
  }

  return { qualCode, grantedByCertId, currentlyEligible };
}

export async function flipEligibilityOnCertExpired(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  memberId: string,
  certId: string,
  certStatus: CertStatus,
  correlationId: string,
): Promise<readonly MemberQualification[]> {
  const pk = buildDeptScopedPk(deptId, 'MEMBER', memberId);
  const heldQuals: Record<string, unknown>[] = [];
  try {
    let lastEvaluatedKey: Record<string, unknown> | undefined;
    do {
      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'pk = :pkVal AND begins_with(sk, :skPrefix)',
          FilterExpression: 'grantedByCertId = :certId AND currentlyEligible = :eligible',
          ExpressionAttributeValues: {
            ':pkVal': pk,
            ':skPrefix': 'QUAL#',
            ':certId': certId,
            ':eligible': true,
          },
          ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
        }),
      );
      heldQuals.push(...(result.Items ?? []));
      lastEvaluatedKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastEvaluatedKey);
  } catch (error) {
    logRepositoryError('personnel.quals.eligibility.flip.readFailed', error, {
      deptId,
      memberId,
      certId,
    });
    throw error;
  }

  if (heldQuals.length === 0) {
    return [];
  }

  const flipped: MemberQualification[] = [];
  const transactItems = heldQuals.flatMap((item) => {
    const qualCode = item.qualCode as string;
    const currentlyEligible = deriveCurrentlyEligible(certId, certStatus);
    flipped.push({ qualCode, grantedByCertId: certId, currentlyEligible });
    return [
      {
        Update: {
          TableName: tableName,
          Key: { pk, sk: item.sk as string },
          UpdateExpression: 'SET currentlyEligible = :eligible',
          ConditionExpression: 'grantedByCertId = :certId',
          ExpressionAttributeValues: { ':eligible': currentlyEligible, ':certId': certId },
        },
      },
      {
        Put: {
          TableName: tableName,
          Item: {
            pk,
            sk: `OUTBOX#${randomUUID()}`,
            ...buildOutboxEnvelope(correlationId, {
              deptId,
              memberId,
              qualCode,
              currentlyEligible,
              grantedByCertId: certId,
            }),
          },
        },
      },
    ];
  });

  try {
    await client.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch (error) {
    logRepositoryError('personnel.quals.eligibility.flip.writeFailed', error, {
      deptId,
      memberId,
      certId,
    });
    throw error;
  }

  return flipped;
}
