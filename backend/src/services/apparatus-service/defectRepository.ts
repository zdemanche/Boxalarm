import { randomUUID } from 'node:crypto';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { buildOutboxRecord } from '@boxalarm/outbox';

export type DefectSeverity = 'MINOR' | 'MAJOR' | 'OUT_OF_SERVICE';
export type DefectStatus = 'OPEN' | 'RESOLVED';

export interface DefectRecord {
  readonly defectId: string;
  readonly apparatusId: string;
  readonly unitId: string;
  readonly description: string;
  readonly severity: DefectSeverity;
  readonly status: DefectStatus;
  readonly reportedBy: string;
  readonly reportedAt: number;
  readonly photoS3Key: string | null;
  readonly outOfService: boolean;
  /** The check-sheet item this defect is against (truck check fail); null when hand-typed. */
  readonly itemCode: string | null;
}

export interface CreateDefectInput {
  readonly deptId: VerifiedDeptId;
  readonly unitId: string;
  readonly description: string;
  readonly severity: DefectSeverity;
  readonly reportedByMemberId: string;
  readonly correlationId: string;
  readonly photoS3Key?: string | null;
  readonly itemCode?: string | null;
  readonly clientMutationId?: string;
  readonly defectId?: string;
  readonly now?: () => number;
}

export class ApparatusNotFoundError extends Error {
  constructor(unitId: string) {
    super(`Apparatus ${unitId} was not found`);
    this.name = 'ApparatusNotFoundError';
  }
}

export class DuplicateDefectReportError extends Error {
  constructor(clientMutationId: string) {
    super(`Defect report with clientMutationId "${clientMutationId}" already exists`);
    this.name = 'DuplicateDefectReportError';
  }
}

export class DefectRepositoryUnavailableError extends Error {
  readonly reason: string;

  constructor(cause: unknown) {
    super('The apparatus defect data store is temporarily unavailable');
    this.name = 'DefectRepositoryUnavailableError';
    this.cause = cause;
    this.reason = cause instanceof Error ? cause.constructor.name : 'UnknownError';
  }
}

interface ApparatusLookup {
  readonly apparatusId: string;
  readonly unitId: string;
  readonly status?: string;
}

function epochSeconds(now?: () => number): number {
  return now ? now() : Math.floor(Date.now() / 1000);
}

function toDefectRecord(item: Record<string, unknown>, unitId: string): DefectRecord {
  const severity = item.severity as DefectSeverity;
  return {
    defectId: item.defectId as string,
    apparatusId: item.apparatusId as string,
    unitId,
    description: item.description as string,
    severity,
    status: item.status as DefectStatus,
    reportedBy: item.reportedBy as string,
    reportedAt: item.reportedAt as number,
    photoS3Key: (item.photoS3Key as string | null | undefined) ?? null,
    outOfService: severity === 'OUT_OF_SERVICE',
    itemCode: typeof item.itemCode === 'string' ? item.itemCode : null,
  };
}

async function findApparatusByUnitId(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  unitId: string,
): Promise<ApparatusLookup | undefined> {
  const output = await client.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI3',
      KeyConditionExpression: 'gsi3pk = :registryKey AND gsi3sk = :unitId',
      ExpressionAttributeValues: {
        ':registryKey': buildDeptScopedPk(deptId, 'APPARATUS'),
        ':unitId': unitId,
      },
      Limit: 1,
    }),
  );
  const item = output.Items?.[0];
  if (!item) {
    return undefined;
  }
  const storedPartitionKey = item['pk'] as string;
  const apparatusId =
    typeof item.apparatusId === 'string'
      ? item.apparatusId
      : storedPartitionKey.slice(storedPartitionKey.lastIndexOf('#') + 1);
  return {
    apparatusId,
    unitId: item.unitId as string,
    ...(typeof item.status === 'string' ? { status: item.status } : {}),
  };
}

export async function getDefectByIdempotencyKey(
  client: DynamoDBDocumentClient,
  tableName: string,
  input: {
    readonly deptId: VerifiedDeptId;
    readonly unitId: string;
    readonly clientMutationId: string;
  },
): Promise<DefectRecord | undefined> {
  const apparatus = await findApparatusByUnitId(client, tableName, input.deptId, input.unitId);
  if (!apparatus) {
    return undefined;
  }
  const idempotencySk = `IDEMPOTENCY#DEFECT#${input.clientMutationId}`;
  const idempotencyQuery = await client.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk AND sk = :sk',
      ExpressionAttributeValues: {
        [':pk']: buildDeptScopedPk(input.deptId, 'APPARATUS', apparatus.apparatusId),
        [':sk']: idempotencySk,
      },
      Limit: 1,
    }),
  );
  const idempotencyItem = idempotencyQuery.Items?.[0];
  if (!idempotencyItem) {
    return undefined;
  }
  const defectId = idempotencyItem.defectId as string;
  const defectGet = await client.send(
    new GetCommand({
      TableName: tableName,
      Key: {
        pk: buildDeptScopedPk(input.deptId, 'APPARATUS', apparatus.apparatusId),
        sk: `DEFECT#${defectId}`,
      },
    }),
  );
  if (!defectGet.Item) {
    return undefined;
  }
  return toDefectRecord(defectGet.Item, apparatus.unitId);
}

export async function createDefect(
  client: DynamoDBDocumentClient,
  tableName: string,
  input: CreateDefectInput,
): Promise<DefectRecord> {
  const apparatus = await findApparatusByUnitId(client, tableName, input.deptId, input.unitId);
  if (!apparatus) {
    throw new ApparatusNotFoundError(input.unitId);
  }

  const defectId = input.defectId ?? `DEF-${randomUUID()}`;
  const reportedAt = epochSeconds(input.now);
  const photoS3Key = input.photoS3Key ?? null;
  const itemCode = input.itemCode ?? null;
  const outOfService = input.severity === 'OUT_OF_SERVICE';

  const defectItem = {
    pk: buildDeptScopedPk(input.deptId, 'APPARATUS', apparatus.apparatusId),
    sk: `DEFECT#${defectId}`,
    entityType: 'DEFECT',
    defectId,
    apparatusId: apparatus.apparatusId,
    unitId: apparatus.unitId,
    description: input.description,
    severity: input.severity,
    status: 'OPEN' as const,
    reportedBy: input.reportedByMemberId,
    reportedAt,
    photoS3Key,
    ...(itemCode !== null ? { itemCode } : {}),
    gsi3pk: buildDeptScopedPk(input.deptId, 'DEFECT'),
    gsi3sk: `OPEN#${reportedAt}`,
  };

  const outboxRecord = buildOutboxRecord(
    input.deptId,
    'apparatus-service',
    'apparatus.defect.reported',
    input.correlationId,
    {
      defectId,
      apparatusId: apparatus.apparatusId,
      unitLabel: apparatus.unitId,
      reportedByMemberId: input.reportedByMemberId,
      severity: input.severity,
      ...(photoS3Key !== null ? { photoS3Key } : {}),
      ...(itemCode !== null ? { itemCode } : {}),
      outOfService,
      deptId: input.deptId,
    },
  );

  const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
    {
      Put: {
        TableName: tableName,
        Item: defectItem,
        ConditionExpression: 'attribute_not_exists(sk)',
      },
    },
    { Put: { TableName: tableName, Item: outboxRecord } },
  ];

  if (input.clientMutationId) {
    transactItems.push({
      Put: {
        TableName: tableName,
        Item: {
          pk: buildDeptScopedPk(input.deptId, 'APPARATUS', apparatus.apparatusId),
          sk: `IDEMPOTENCY#DEFECT#${input.clientMutationId}`,
          entityType: 'DEFECT_IDEMPOTENCY',
          defectId,
          clientMutationId: input.clientMutationId,
          createdAt: reportedAt,
        },
        ConditionExpression: 'attribute_not_exists(sk)',
      },
    });
  }

  try {
    await client.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch (error) {
    const cancellationReasons =
      error instanceof TransactionCanceledException ? error.CancellationReasons : undefined;
    if (
      input.clientMutationId &&
      cancellationReasons?.some((reason) => reason.Code === 'ConditionalCheckFailed')
    ) {
      throw new DuplicateDefectReportError(input.clientMutationId);
    }
    throw new DefectRepositoryUnavailableError(error);
  }

  return {
    defectId,
    apparatusId: apparatus.apparatusId,
    unitId: apparatus.unitId,
    description: input.description,
    severity: input.severity,
    status: 'OPEN',
    reportedBy: input.reportedByMemberId,
    reportedAt,
    photoS3Key,
    outOfService,
    itemCode,
  };
}

/** A defect on the dashboard's dept-wide open list: the DEFECT row's own fields. */
export interface OpenDefect {
  readonly defectId: string;
  readonly apparatusId: string;
  readonly unitId: string;
  readonly description: string;
  readonly severity: DefectSeverity;
  readonly reportedAt: number;
  readonly photoS3Key: string | null;
  readonly itemCode: string | null;
}

/** Bounds the dashboard response; far beyond a single department's plausible open defects. */
export const MAX_OPEN_DEFECTS = 500;

export interface OpenDefectsPage {
  readonly defects: OpenDefect[];
  /** The cap was hit with more rows behind it: the oldest open defects are not in the list. */
  readonly truncated: boolean;
}

/**
 * Every open defect in the department, NEWEST first (review MAJOR-2: a capped oldest-first
 * list would silently drop every new defect once a department passes the cap), in one GSI3
 * Query (owed-stories review minor 8: the dashboard previously fetched each unit's detail).
 * Serves on the index the DEFECT rows already carry — `gsi3pk = DEPT#{dept}#DEFECT`,
 * `gsi3sk = OPEN#{reportedAt}` — so no new key attributes and no backfill. Capped with an
 * explicit `truncated` flag, never a Scan.
 */
export async function listOpenDefects(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
): Promise<OpenDefectsPage> {
  const defects: OpenDefect[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  try {
    do {
      const page = await client.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: 'GSI3',
          KeyConditionExpression: 'gsi3pk = :gsi3pk AND begins_with(gsi3sk, :open)',
          ExpressionAttributeValues: {
            ':gsi3pk': buildDeptScopedPk(deptId, 'DEFECT'),
            ':open': 'OPEN#',
          },
          // Newest first: when the cap cuts, it cuts the oldest, and the response says so.
          ScanIndexForward: false,
          Limit: MAX_OPEN_DEFECTS - defects.length,
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      for (const item of page.Items ?? []) {
        defects.push({
          defectId: item.defectId as string,
          apparatusId: item.apparatusId as string,
          unitId: item.unitId as string,
          description: item.description as string,
          severity: item.severity as DefectSeverity,
          reportedAt: item.reportedAt as number,
          photoS3Key: (item.photoS3Key as string | null | undefined) ?? null,
          itemCode: (item.itemCode as string | null | undefined) ?? null,
        });
      }
      exclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (exclusiveStartKey && defects.length < MAX_OPEN_DEFECTS);
  } catch (error) {
    throw new DefectRepositoryUnavailableError(error);
  }
  // At exactly the cap with a page boundary left, this can read true once with nothing
  // behind it; a spurious "oldest not listed" note is the safe side of a silent drop.
  return { defects, truncated: defects.length >= MAX_OPEN_DEFECTS && !!exclusiveStartKey };
}

export class DefectNotFoundError extends Error {
  constructor(defectId: string) {
    super(`Defect ${defectId} was not found`);
    this.name = 'DefectNotFoundError';
  }
}

export class DefectAlreadyResolvedError extends Error {
  constructor(defectId: string) {
    super(`Defect ${defectId} is already resolved`);
    this.name = 'DefectAlreadyResolvedError';
  }
}

export interface ResolveDefectInput {
  readonly deptId: VerifiedDeptId;
  readonly unitId: string;
  readonly defectId: string;
  /** How it was fixed — required, like the report's description. */
  readonly note: string;
  readonly resolvedBy: string;
}

export interface ResolveDefectResult {
  readonly severity: DefectSeverity;
  readonly resolvedAt: number;
  /**
   * The unit's registry status is still OUT_OF_SERVICE after this resolution. Deliberately a
   * warning, never a refusal (review MAJOR-2 asked whether the coupling should refuse): the
   * natural order is fix -> resolve the defect -> return the unit to service, so refusing
   * resolution while OUT_OF_SERVICE would force the return FIRST — a unit in service with its
   * out-of-service defect still open, which is backwards — and a unit can also be out of
   * service for a reason unrelated to this defect. Return-to-service keeps its own control
   * (PUT service-status, same officer tier, emits apparatus.serviceStatus.changed).
   */
  readonly unitStillOutOfService: boolean;
}

/** Mirrors buildAuditEntry in inventory/compartmentItemRepository.ts (AUDIT_LOG_ENTRY rows). */
function buildDefectAuditEntry(
  input: ResolveDefectInput,
  resolvedAt: number,
): Record<string, unknown> {
  const date = new Date(resolvedAt * 1000).toISOString().slice(0, 10);
  return {
    pk: buildDeptScopedPk(input.deptId, 'AUDIT', date),
    sk: `${resolvedAt}#DEFECT#${input.defectId}#${input.resolvedBy}`,
    entityType: 'AUDIT_LOG_ENTRY',
    mutatedEntityType: 'DEFECT',
    mutatedEntityId: input.defectId,
    action: 'UPDATE',
    actorId: input.resolvedBy,
    changedFields: {
      status: { old: 'OPEN', new: 'RESOLVED' },
      resolutionNote: { old: undefined, new: input.note },
    },
    ts: resolvedAt,
  };
}

/**
 * Closes a defect (review MAJOR-2: nothing resolved a defect, so the open list only ever
 * grew): sets RESOLVED + resolvedBy/resolvedAt/resolutionNote and moves the row's gsi3sk from
 * `OPEN#{reportedAt}` to `RESOLVED#{reportedAt}`, so it leaves the open-defects index (and
 * getApparatusDetail's status filter) while the history stays queryable. One transaction with
 * an AUDIT_LOG_ENTRY row; conditional on the defect still being OPEN, so a double resolve is
 * a 409, not a lost note.
 */
export async function resolveDefect(
  client: DynamoDBDocumentClient,
  tableName: string,
  input: ResolveDefectInput,
): Promise<ResolveDefectResult> {
  const apparatus = await findApparatusByUnitId(client, tableName, input.deptId, input.unitId);
  if (!apparatus) {
    throw new ApparatusNotFoundError(input.unitId);
  }
  const key = {
    pk: buildDeptScopedPk(input.deptId, 'APPARATUS', apparatus.apparatusId),
    sk: `DEFECT#${input.defectId}`,
  };
  const existing = await client.send(
    new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }),
  );
  if (!existing.Item) {
    throw new DefectNotFoundError(input.defectId);
  }
  if (existing.Item.status !== 'OPEN') {
    throw new DefectAlreadyResolvedError(input.defectId);
  }
  const severity = existing.Item.severity as DefectSeverity;
  const reportedAt = existing.Item.reportedAt as number;
  const resolvedAt = epochSeconds();
  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tableName,
              Key: key,
              UpdateExpression:
                'SET #status = :resolved, resolvedBy = :by, resolvedAt = :at, ' +
                'resolutionNote = :note, gsi3sk = :gsi3sk',
              ConditionExpression: 'attribute_exists(sk) AND #status = :open',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':resolved': 'RESOLVED',
                ':open': 'OPEN',
                ':by': input.resolvedBy,
                ':at': resolvedAt,
                ':note': input.note,
                ':gsi3sk': `RESOLVED#${reportedAt}`,
              },
            },
          },
          { Put: { TableName: tableName, Item: buildDefectAuditEntry(input, resolvedAt) } },
        ],
      }),
    );
  } catch (error) {
    const lostRace =
      error instanceof TransactionCanceledException &&
      (error.CancellationReasons ?? []).some((entry) => entry.Code === 'ConditionalCheckFailed');
    if (lostRace) {
      throw new DefectAlreadyResolvedError(input.defectId);
    }
    throw new DefectRepositoryUnavailableError(error);
  }
  return {
    severity,
    resolvedAt,
    unitStillOutOfService: apparatus.status === 'OUT_OF_SERVICE',
  };
}
