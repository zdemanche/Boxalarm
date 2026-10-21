import { randomUUID } from 'node:crypto';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { buildAuditLogEntryTransactItem } from '../../platform-service/audit/auditEntry.js';
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

export class CertChangedError extends Error {
  constructor(readonly certId: string) {
    super(`Certification ${certId} changed status while the qualification was being saved`);
    this.name = 'CertChangedError';
  }
}

const MAX_PUT_ATTEMPTS = 3;
const QUAL_PUT_INDEX = 0;
const CERT_CHECK_INDEX = 3;

function failedAt(error: unknown, index: number): boolean {
  return (
    error instanceof TransactionCanceledException &&
    error.CancellationReasons?.[index]?.Code === 'ConditionalCheckFailed'
  );
}

function isRetryablePutFailure(error: unknown): boolean {
  return (
    failedAt(error, QUAL_PUT_INDEX) ||
    failedAt(error, CERT_CHECK_INDEX) ||
    (error instanceof TransactionCanceledException &&
      (error.CancellationReasons ?? []).some((reason) => reason.Code === 'TransactionConflict'))
  );
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

function buildOutboxEntry(
  eventId: string,
  correlationId: string,
  payload: EligibilityChangedPayload,
) {
  return {
    entityType: 'OUTBOX_ENTRY' as const,
    eventId,
    eventTime: new Date().toISOString(),
    eventType: EVENT_TYPE,
    source: EVENT_SOURCE,
    correlationId,
    schemaVersion: SCHEMA_VERSION,
    payload,
    sentAt: null,
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
      new GetCommand({
        TableName: tableName,
        Key: { pk, sk: `CERT#${certId}` },
        ConsistentRead: true,
      }),
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

async function readExistingQual(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  memberId: string,
  qualCode: string,
): Promise<MemberQualification | undefined> {
  try {
    const result = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: buildDeptScopedPk(deptId, 'MEMBER', memberId), sk: `QUAL#${qualCode}` },
        ConsistentRead: true,
      }),
    );
    return result.Item
      ? {
          qualCode,
          grantedByCertId: (result.Item.grantedByCertId as string | null | undefined) ?? null,
          currentlyEligible: result.Item.currentlyEligible as boolean,
        }
      : undefined;
  } catch (error) {
    logRepositoryError('personnel.quals.existingLookup.failed', error, {
      deptId,
      memberId,
      qualCode,
    });
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
  actorId: string,
): Promise<MemberQualification> {
  const pk = buildDeptScopedPk(deptId, 'MEMBER', memberId);
  for (let attempt = 1; ; attempt += 1) {
    const existing = await readExistingQual(client, tableName, deptId, memberId, qualCode);
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
    const outboxEventId = randomUUID();
    const outboxItem = {
      pk,
      sk: `OUTBOX#${outboxEventId}`,
      ...buildOutboxEntry(outboxEventId, correlationId, {
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
            {
              Put: {
                TableName: tableName,
                Item: qualItem,
                ...(existing
                  ? {
                      ConditionExpression:
                        '(attribute_not_exists(grantedByCertId) OR grantedByCertId = :prevCert) AND currentlyEligible = :prevEligible',
                      ExpressionAttributeValues: {
                        ':prevCert': existing.grantedByCertId,
                        ':prevEligible': existing.currentlyEligible,
                      },
                    }
                  : { ConditionExpression: 'attribute_not_exists(pk)' }),
              },
            },
            { Put: { TableName: tableName, Item: outboxItem } },
            buildAuditLogEntryTransactItem(tableName, {
              deptId,
              actorId,
              mutatedEntityType: 'MEMBER_QUALIFICATION',
              mutatedEntityId: `${memberId}-${qualCode}`,
              action: existing ? 'UPDATE' : 'CREATE',
              before: {
                qualCode: existing?.qualCode ?? null,
                grantedByCertId: existing?.grantedByCertId ?? null,
                currentlyEligible: existing?.currentlyEligible ?? null,
              },
              after: { qualCode, grantedByCertId, currentlyEligible },
              traceId: correlationId,
            }),
            ...(grantedByCertId === null
              ? []
              : [
                  {
                    ConditionCheck: {
                      TableName: tableName,
                      Key: { pk, sk: `CERT#${grantedByCertId}` },
                      ConditionExpression: '#status = :observedStatus',
                      ExpressionAttributeNames: { '#status': 'status' },
                      ExpressionAttributeValues: { ':observedStatus': certStatus },
                    },
                  },
                ]),
          ],
        }),
      );
      return { qualCode, grantedByCertId, currentlyEligible };
    } catch (error) {
      logRepositoryError('personnel.quals.write.failed', error, { deptId, memberId, qualCode });
      if (isRetryablePutFailure(error)) {
        if (attempt < MAX_PUT_ATTEMPTS) {
          continue;
        }
        if (grantedByCertId !== null && failedAt(error, CERT_CHECK_INDEX)) {
          throw new CertChangedError(grantedByCertId);
        }
      }
      throw error;
    }
  }
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
          ConsistentRead: true,
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
    const flipOutboxEventId = randomUUID();
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
            sk: `OUTBOX#${flipOutboxEventId}`,
            ...buildOutboxEntry(flipOutboxEventId, correlationId, {
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
