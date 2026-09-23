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
}

export interface CreateDefectInput {
  readonly deptId: VerifiedDeptId;
  readonly unitId: string;
  readonly description: string;
  readonly severity: DefectSeverity;
  readonly reportedByMemberId: string;
  readonly correlationId: string;
  readonly photoS3Key?: string | null;
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
  return { apparatusId, unitId: item.unitId as string };
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
  };
}
