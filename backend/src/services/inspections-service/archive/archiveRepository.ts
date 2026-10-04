import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { buildOutboxRecord } from '@boxalarm/outbox';

/**
 * Archiving an occupancy or a hydrant (CHIEF/ADMIN, Cedar ArchiveOccupancy / ArchiveHydrant).
 *
 * Occupancy addresses are immutable, so correcting a mis-addressed occupancy means creating a
 * new one — and the old one's pre-plan must then stop matching dispatches to *its* address.
 * Archive takes the record off the department list, address, map and due-date indexes, blocks further
 * writes (putPrePlan / updateHydrant condition on attribute_not_exists(archivedAt)), and emits
 * the entity's usual inspections.*.updated event with `archived: true` in the same
 * transaction, so the alerting consumer tombstones its copy (index keys removed). The
 * consumer applies a tombstone whatever its eventTime (only its dedup marker guards it) and
 * never applies anything after one — delivery order is not relied on. There is no un-archive.
 */

export class ArchiveTargetNotFoundError extends Error {
  constructor(kind: string, id: string) {
    super(`${kind} "${id}" was not found`);
    this.name = 'ArchiveTargetNotFoundError';
  }
}

export interface ArchiveResult {
  readonly archivedAt: number;
  /** False when it was already archived (the call is idempotent). */
  readonly changed: boolean;
}

function auditItem(
  deptId: VerifiedDeptId,
  entityType: 'OCCUPANCY' | 'HYDRANT',
  entityId: string,
  actorId: string,
  ts: number,
): Record<string, unknown> {
  const date = new Date(ts).toISOString().slice(0, 10);
  return {
    pk: buildDeptScopedPk(deptId, 'AUDIT', date),
    sk: `${ts}#${entityType}#${entityId}#${actorId}`,
    entityType: 'AUDIT_LOG_ENTRY',
    mutatedEntityType: entityType,
    mutatedEntityId: entityId,
    action: 'ARCHIVE',
    actorId,
    changedFields: { archivedAt: { old: null, new: ts } },
    ts,
    gsi3pk: buildDeptScopedPk(deptId, 'AUDIT', 'ENTITY', entityType, entityId),
    gsi3sk: `${ts}`,
  };
}

async function readMetadata(
  doc: DynamoDBDocumentClient,
  tableName: string,
  pk: string,
): Promise<Record<string, unknown> | undefined> {
  const { Item } = await doc.send(
    new GetCommand({ TableName: tableName, Key: { pk, sk: 'METADATA' }, ConsistentRead: true }),
  );
  return Item;
}

function isConditionFailure(error: unknown): boolean {
  return (
    error instanceof TransactionCanceledException &&
    (error.CancellationReasons ?? []).some((reason) => reason.Code === 'ConditionalCheckFailed')
  );
}

async function archive(
  doc: DynamoDBDocumentClient,
  tableName: string,
  kind: 'OCCUPANCY' | 'HYDRANT',
  id: string,
  buildItems: (
    metadata: Record<string, unknown>,
    now: number,
  ) => NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']>,
  pk: string,
): Promise<ArchiveResult> {
  const metadata = await readMetadata(doc, tableName, pk);
  if (!metadata) {
    throw new ArchiveTargetNotFoundError(kind.toLowerCase(), id);
  }
  if (typeof metadata.archivedAt === 'number') {
    return { archivedAt: metadata.archivedAt, changed: false };
  }
  const now = Date.now();
  try {
    await doc.send(new TransactWriteCommand({ TransactItems: buildItems(metadata, now) }));
  } catch (error) {
    if (!isConditionFailure(error)) throw error;
    // Archived (or deleted) concurrently: report what is there now.
    const current = await readMetadata(doc, tableName, pk);
    if (typeof current?.archivedAt === 'number') {
      return { archivedAt: current.archivedAt, changed: false };
    }
    throw new ArchiveTargetNotFoundError(kind.toLowerCase(), id);
  }
  return { archivedAt: now, changed: true };
}

/** Removes an index row's GSI3 keys so it drops off the department list / address index. */
function offIndex(tableName: string, pk: string, sk: string) {
  return {
    Update: {
      TableName: tableName,
      Key: { pk, sk },
      // Unconditional: a record that predates its index row must still archive (the Update
      // then leaves a key-only stub that no index can see).
      UpdateExpression: 'REMOVE gsi3pk, gsi3sk',
    },
  };
}

const ARCHIVE_METADATA_CONDITION = 'attribute_exists(pk) AND attribute_not_exists(archivedAt)';

export async function archiveOccupancy(
  doc: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  occupancyId: string,
  actorId: string,
): Promise<ArchiveResult> {
  const pk = buildDeptScopedPk(deptId, 'OCCUPANCY', occupancyId);
  return archive(
    doc,
    tableName,
    'OCCUPANCY',
    occupancyId,
    (metadata, now) => [
      {
        Update: {
          TableName: tableName,
          Key: { pk, sk: 'METADATA' },
          ConditionExpression: ARCHIVE_METADATA_CONDITION,
          // Off the map (GSI3 GEO bucket) as well as the list below.
          UpdateExpression: 'SET archivedAt = :now, archivedBy = :actor REMOVE gsi3pk, gsi3sk',
          ExpressionAttributeValues: { ':now': now, ':actor': actorId },
        },
      },
      // Index rows are taken off their GSI3 partitions, not deleted: inspections roles hold
      // no DeleteItem (infrastructure test/inspections/wiring.test.ts).
      offIndex(tableName, pk, 'LIST'),
      ...(typeof metadata.normalizedAddress === 'string'
        ? [offIndex(tableName, pk, `ADDR#${metadata.normalizedAddress}`)]
        : []),
      {
        Put: {
          TableName: tableName,
          Item: auditItem(deptId, 'OCCUPANCY', occupancyId, actorId, now),
          ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
        },
      },
      {
        // Emitted whether or not a pre-plan exists yet, so a pre-plan written concurrently is
        // still tombstoned (the consumer applies tombstones regardless of eventTime).
        Put: {
          TableName: tableName,
          Item: buildOutboxRecord(
            deptId,
            'inspections-service',
            'inspections.preplan.updated',
            occupancyId,
            { deptId, occupancyId, archived: true },
          ) as unknown as Record<string, unknown>,
        },
      },
    ],
    pk,
  );
}

export async function archiveHydrant(
  doc: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  hydrantId: string,
  actorId: string,
): Promise<ArchiveResult> {
  const pk = buildDeptScopedPk(deptId, 'HYDRANT', hydrantId);
  return archive(
    doc,
    tableName,
    'HYDRANT',
    hydrantId,
    (_metadata, now) => [
      {
        Update: {
          TableName: tableName,
          Key: { pk, sk: 'METADATA' },
          ConditionExpression: ARCHIVE_METADATA_CONDITION,
          // Off the map (GSI3 GEO) and the flow-test due list (GSI2) as well as the list.
          UpdateExpression:
            'SET archivedAt = :now, archivedBy = :actor, updatedAt = :now REMOVE gsi2pk, gsi2sk, gsi3pk, gsi3sk',
          ExpressionAttributeValues: { ':now': now, ':actor': actorId },
        },
      },
      offIndex(tableName, pk, 'LIST'),
      {
        Put: {
          TableName: tableName,
          Item: auditItem(deptId, 'HYDRANT', hydrantId, actorId, now),
          ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
        },
      },
      {
        Put: {
          TableName: tableName,
          Item: buildOutboxRecord(
            deptId,
            'inspections-service',
            'inspections.hydrant.updated',
            hydrantId,
            { hydrantId, deptId, archived: true },
          ) as unknown as Record<string, unknown>,
        },
      },
    ],
    pk,
  );
}
