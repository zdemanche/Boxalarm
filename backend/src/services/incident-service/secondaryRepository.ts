import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { assertNoDelimiter, buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { buildOutboxRecord } from '@boxalarm/outbox';
import { IncidentNotFoundError, isConditionFailureAt } from './repository.js';
import {
  BUMP_CONTENT_VERSION,
  CONTENT_VERSION_VALUES,
  IncidentLockedError,
  NOT_LOCKED_CONDITION,
  explainMetadataConditionFailure,
} from './lock.js';

export interface IncidentSecondary {
  readonly incidentId: string;
  readonly secondaryType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly affectedMemberIds: readonly string[];
  readonly updatedAt: number;
  /** Optimistic-concurrency counter; absent on rows written before it existed. */
  readonly version?: number;
}

/** Another write changed the module between this request's read and its write. */
export class SecondaryConflictError extends Error {
  constructor(incidentId: string, secondaryType: string) {
    super(`the ${secondaryType} module of incident ${incidentId} was changed concurrently`);
    this.name = 'SecondaryConflictError';
  }
}

function secondaryKey(deptId: VerifiedDeptId, incidentId: string, secondaryType: string) {
  return {
    pk: buildDeptScopedPk(deptId, 'INCIDENT', incidentId),
    sk: `SECONDARY#${secondaryType}`,
  };
}

export async function getIncidentSecondary(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  incidentId: string,
  secondaryType: string,
): Promise<IncidentSecondary | undefined> {
  assertNoDelimiter(incidentId, 'incidentId');
  assertNoDelimiter(secondaryType, 'secondaryType');
  const result = await client.send(
    new GetCommand({
      TableName: tableName,
      Key: secondaryKey(deptId, incidentId, secondaryType),
      ConsistentRead: true,
    }),
  );
  return result.Item as IncidentSecondary | undefined;
}

export interface SecondaryWriteContext {
  /** The module as this request read it; undefined when it did not exist. */
  readonly previous: IncidentSecondary | undefined;
  readonly actorId: string;
}

/**
 * The write is conditional on the module still being the one `previous` describes (review
 * M3): a create requires no module, an update requires the version read (or, for a row from
 * before versions, the updatedAt read). A concurrent writer fails with SecondaryConflictError
 * instead of silently overwriting responder-exposure evidence.
 */
function concurrencyCondition(previous: IncidentSecondary | undefined): {
  ConditionExpression: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
} {
  if (!previous) {
    return { ConditionExpression: 'attribute_not_exists(pk)' };
  }
  if (previous.version !== undefined) {
    return {
      ConditionExpression: '#version = :previousVersion',
      ExpressionAttributeNames: { '#version': 'version' },
      ExpressionAttributeValues: { ':previousVersion': previous.version },
    };
  }
  return {
    ConditionExpression: 'attribute_not_exists(#version) AND updatedAt = :previousUpdatedAt',
    ExpressionAttributeNames: { '#version': 'version' },
    ExpressionAttributeValues: { ':previousUpdatedAt': previous.updatedAt },
  };
}

/**
 * Writes the Secondary module, its `incident.secondary.updated` OUTBOX_ENTRY and an
 * AUDIT_LOG_ENTRY carrying the old and new payload and affected members, atomically.
 * INCIDENT_SECONDARY is the most sensitive non-PHI data in the system (architecture 3.5);
 * without the before-image an erased exposure left no trace. Returns the new version.
 */
export async function putIncidentSecondary(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  secondary: IncidentSecondary,
  traceId: string,
  write: SecondaryWriteContext,
): Promise<number> {
  // Enforced here, not only at the API boundary, since both values become key segments.
  assertNoDelimiter(secondary.incidentId, 'incidentId');
  assertNoDelimiter(secondary.secondaryType, 'secondaryType');
  const outboxRecord = buildOutboxRecord(
    deptId,
    'incident-service',
    'incident.secondary.updated',
    traceId,
    {
      incidentId: secondary.incidentId,
      deptId,
      secondaryType: secondary.secondaryType,
      affectedMemberIds: secondary.affectedMemberIds,
      updatedAt: secondary.updatedAt,
    },
  );
  const version = (write.previous?.version ?? 0) + 1;
  const auditTs = Date.now();
  await client
    .send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: {
                ...secondaryKey(deptId, secondary.incidentId, secondary.secondaryType),
                entityType: 'INCIDENT_SECONDARY',
                incidentId: secondary.incidentId,
                secondaryType: secondary.secondaryType,
                payload: secondary.payload,
                affectedMemberIds: secondary.affectedMemberIds,
                updatedAt: secondary.updatedAt,
                version,
                updatedBy: write.actorId,
              },
              ...concurrencyCondition(write.previous),
            },
          },
          { Put: { TableName: tableName, Item: outboxRecord } },
          {
            // The parent report must exist and not be locked for review, and the module is
            // content: bump contentVersion (lock.ts).
            Update: {
              TableName: tableName,
              Key: {
                pk: buildDeptScopedPk(deptId, 'INCIDENT', secondary.incidentId),
                sk: 'METADATA',
              },
              ConditionExpression: `attribute_exists(pk) AND ${NOT_LOCKED_CONDITION}`,
              UpdateExpression: `SET ${BUMP_CONTENT_VERSION}, updatedAt = :metadataUpdatedAt`,
              ExpressionAttributeValues: {
                ...CONTENT_VERSION_VALUES,
                ':metadataUpdatedAt': secondary.updatedAt,
              },
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: {
                pk: buildDeptScopedPk(
                  deptId,
                  'AUDIT',
                  new Date(auditTs).toISOString().slice(0, 10),
                ),
                sk: `${auditTs}#INCIDENT#${secondary.incidentId}#${write.actorId}`,
                entityType: 'AUDIT_LOG_ENTRY',
                mutatedEntityType: 'INCIDENT',
                mutatedEntityId: secondary.incidentId,
                action: write.previous ? 'UPDATE_SECONDARY' : 'CREATE_SECONDARY',
                actorId: write.actorId,
                secondaryType: secondary.secondaryType,
                changedFields: {
                  payload: { old: write.previous?.payload ?? null, new: secondary.payload },
                  affectedMemberIds: {
                    old: write.previous?.affectedMemberIds ?? null,
                    new: secondary.affectedMemberIds,
                  },
                },
                ts: auditTs,
                gsi3pk: buildDeptScopedPk(
                  deptId,
                  'AUDIT',
                  'ENTITY',
                  'INCIDENT',
                  secondary.incidentId,
                ),
                gsi3sk: String(auditTs),
              },
              // An audit row is written once and never replaced.
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
        ],
      }),
    )
    .catch(async (error: unknown) => {
      if (isConditionFailureAt(error, 0)) {
        throw new SecondaryConflictError(secondary.incidentId, secondary.secondaryType);
      }
      if (isConditionFailureAt(error, 2)) {
        const reason = await explainMetadataConditionFailure(
          client,
          tableName,
          deptId,
          secondary.incidentId,
        );
        throw reason === 'locked'
          ? new IncidentLockedError(secondary.incidentId)
          : new IncidentNotFoundError(secondary.incidentId);
      }
      throw error;
    });
  return version;
}

/** AC3: each Secondary module comes back as its own distinct record, never merged. */
export async function queryIncidentSecondaries(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  incidentId: string,
): Promise<readonly IncidentSecondary[]> {
  const result = await client.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': buildDeptScopedPk(deptId, 'INCIDENT', incidentId),
        ':prefix': 'SECONDARY#',
      },
    }),
  );
  return (result.Items ?? []) as unknown as IncidentSecondary[];
}
