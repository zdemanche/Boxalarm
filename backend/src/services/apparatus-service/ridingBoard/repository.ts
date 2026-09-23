import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { buildOutboxRecord } from '@boxalarm/outbox';
import { findApparatusItem, logError, type ApparatusStatus } from '../repository.js';
import {
  RidingBoardReadError,
  RidingBoardWriteError,
  parseRidingPositionsConfig,
  seatQualStatus,
  type RidingPosition,
  type SeatQualStatus,
  type SeatState,
} from './entity.js';

const METRICS_NAMESPACE = 'Boxalarm/RidingBoard';

function seatSk(apparatusId: string, positionCode: string): string {
  return `SEAT#${apparatusId}#${positionCode}`;
}

function seatHistSk(apparatusId: string, positionCode: string, clientAssignmentId: string): string {
  return `SEATHIST#${apparatusId}#${positionCode}#${clientAssignmentId}`;
}

function apparatusIdFromPk(pk: string): string {
  return pk.slice(pk.lastIndexOf('#') + 1);
}

interface ApparatusForBoard {
  readonly apparatusId: string;
  readonly unitId: string;
  readonly type: string;
  readonly status: ApparatusStatus;
  readonly outOfServiceReason?: string;
}

async function listApparatusForBoard(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
): Promise<readonly ApparatusForBoard[]> {
  const output = await client.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI3',
      KeyConditionExpression: 'gsi3pk = :gsi3pk',
      ExpressionAttributeValues: { ':gsi3pk': buildDeptScopedPk(deptId, 'APPARATUS') },
    }),
  );
  return (output.Items ?? []).map((item) => ({
    apparatusId: apparatusIdFromPk(item.pk as string),
    unitId: item.unitId as string,
    type: item.type as string,
    status: item.status as ApparatusStatus,
    ...(typeof item.outOfServiceReason === 'string'
      ? { outOfServiceReason: item.outOfServiceReason }
      : {}),
  }));
}

export async function getRidingPositionsConfig(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
): Promise<Readonly<Record<string, readonly RidingPosition[]>>> {
  const result = await client.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: buildDeptScopedPk(deptId), sk: 'CONFIG#RIDING_POSITIONS' },
    }),
  );
  return parseRidingPositionsConfig(result.Item?.value as Record<string, unknown> | undefined);
}

async function listSeatAssignments(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
): Promise<readonly SeatState[]> {
  const output = await client.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': buildDeptScopedPk(deptId, 'DISPATCH', dispatchId),
        ':prefix': 'SEAT#',
      },
    }),
  );
  return (output.Items ?? []).map((item) => ({
    apparatusId: item.apparatusId as string,
    positionCode: item.positionCode as string,
    memberId: (item.memberId as string | null | undefined) ?? null,
    version: item.version as number,
    assignedAt: item.assignedAt as number,
    assignedBy: item.assignedBy as string,
  }));
}

async function readMemberQualCodes(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  memberId: string,
): Promise<ReadonlySet<string>> {
  const output = await client.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': buildDeptScopedPk(deptId, 'MEMBER', memberId),
        ':prefix': 'QUAL#',
      },
    }),
  );
  const codes = new Set<string>();
  for (const item of output.Items ?? []) {
    if (item.currentlyEligible === true && typeof item.qualCode === 'string') {
      codes.add(item.qualCode);
    }
  }
  return codes;
}

export interface BoardPositionAssignment {
  readonly memberId: string;
  readonly version: number;
  readonly assignedAt: number;
  readonly assignedBy: string;
  readonly qualStatus: SeatQualStatus;
}

export interface BoardPosition {
  readonly code: string;
  readonly label: string;
  readonly requiredQual?: string;
  readonly assignment?: BoardPositionAssignment;
}

export interface BoardApparatus {
  readonly apparatusId: string;
  readonly unitId: string;
  readonly type: string;
  readonly status: ApparatusStatus;
  readonly assignable: boolean;
  readonly outOfServiceReason?: string;
  readonly positions: readonly BoardPosition[];
}

export interface RidingBoard {
  readonly dispatchId: string;
  readonly apparatus: readonly BoardApparatus[];
}

export async function getRidingBoard(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
): Promise<RidingBoard> {
  let apparatusList: readonly ApparatusForBoard[];
  let positionsByType: Readonly<Record<string, readonly RidingPosition[]>>;
  let seatAssignments: readonly SeatState[];
  try {
    [apparatusList, positionsByType, seatAssignments] = await Promise.all([
      listApparatusForBoard(client, tableName, deptId),
      getRidingPositionsConfig(client, tableName, deptId),
      listSeatAssignments(client, tableName, deptId, dispatchId),
    ]);
  } catch (error) {
    logError('apparatus.ridingBoard.read.failed', error, { deptId, dispatchId });
    throw new RidingBoardReadError(error);
  }

  const seatsByApparatus = new Map<string, Map<string, SeatState>>();
  for (const seat of seatAssignments) {
    const byPosition = seatsByApparatus.get(seat.apparatusId) ?? new Map<string, SeatState>();
    byPosition.set(seat.positionCode, seat);
    seatsByApparatus.set(seat.apparatusId, byPosition);
  }

  const assignedMemberIds = [
    ...new Set(
      seatAssignments
        .map((seat) => seat.memberId)
        .filter((memberId): memberId is string => memberId !== null),
    ),
  ];
  const qualsByMember = new Map<string, ReadonlySet<string>>();
  try {
    await Promise.all(
      assignedMemberIds.map(async (memberId) => {
        qualsByMember.set(memberId, await readMemberQualCodes(client, tableName, deptId, memberId));
      }),
    );
  } catch (error) {
    logError('apparatus.ridingBoard.read.qualsFailed', error, { deptId, dispatchId });
    throw new RidingBoardReadError(error);
  }

  const apparatus: BoardApparatus[] = apparatusList.map((unit) => {
    const positions = positionsByType[unit.type] ?? [];
    const seatsForUnit = seatsByApparatus.get(unit.apparatusId);
    return {
      apparatusId: unit.apparatusId,
      unitId: unit.unitId,
      type: unit.type,
      status: unit.status,
      assignable: unit.status === 'IN_SERVICE',
      ...(unit.outOfServiceReason !== undefined
        ? { outOfServiceReason: unit.outOfServiceReason }
        : {}),
      positions: positions.map((position): BoardPosition => {
        const seat = seatsForUnit?.get(position.code);
        const base = {
          code: position.code,
          label: position.label,
          ...(position.requiredQual !== undefined ? { requiredQual: position.requiredQual } : {}),
        };
        if (!seat || seat.memberId === null) {
          return base;
        }
        return {
          ...base,
          assignment: {
            memberId: seat.memberId,
            version: seat.version,
            assignedAt: seat.assignedAt,
            assignedBy: seat.assignedBy,
            qualStatus: seatQualStatus(
              position.requiredQual,
              qualsByMember.get(seat.memberId) ?? new Set(),
            ),
          },
        };
      }),
    };
  });

  return { dispatchId, apparatus };
}

async function readSeatState(
  client: DynamoDBDocumentClient,
  tableName: string,
  pk: string,
  sk: string,
): Promise<SeatState | undefined> {
  // Must be strongly consistent: this read's result (previousMemberId) is baked into the
  // outbox event and history record without re-verification, so an eventually-consistent
  // read here can report a stale occupant even though the transaction's own version check
  // (against the true current state) still passes.
  const result = await client.send(
    new GetCommand({ TableName: tableName, Key: { pk, sk }, ConsistentRead: true }),
  );
  const item = result.Item;
  if (!item) {
    return undefined;
  }
  return {
    apparatusId: item.apparatusId as string,
    positionCode: item.positionCode as string,
    memberId: (item.memberId as string | null | undefined) ?? null,
    version: item.version as number,
    assignedAt: item.assignedAt as number,
    assignedBy: item.assignedBy as string,
  };
}

export interface AssignSeatInput {
  readonly unitId: string;
  readonly positionCode: string;
  readonly memberId: string | null;
  readonly expectedVersion: number;
  readonly clientAssignmentId: string;
  readonly assignedBy: string;
}

export type AssignSeatOutcome =
  | { readonly kind: 'APPARATUS_NOT_FOUND' }
  | { readonly kind: 'OUT_OF_SERVICE'; readonly reason?: string }
  | {
      readonly kind: 'ASSIGNED';
      readonly apparatusId: string;
      readonly positionCode: string;
      readonly memberId: string | null;
      readonly previousMemberId: string | null;
      readonly version: number;
    }
  | { readonly kind: 'ALREADY_APPLIED'; readonly current: SeatState | undefined }
  | { readonly kind: 'CONFLICT'; readonly current: SeatState | undefined };

function cancellationCodeAt(error: unknown, index: number): string | undefined {
  if (!(error instanceof TransactionCanceledException)) {
    return undefined;
  }
  return (error.CancellationReasons ?? [])[index]?.Code;
}

export async function assignSeat(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
  input: AssignSeatInput,
): Promise<AssignSeatOutcome> {
  const apparatus = await findApparatusItem(client, tableName, deptId, input.unitId);
  if (!apparatus) {
    return { kind: 'APPARATUS_NOT_FOUND' };
  }
  if (apparatus.status !== 'IN_SERVICE') {
    emitOutcomeMetric(METRICS_NAMESPACE, 'RidingAssignmentOutOfService');
    return {
      kind: 'OUT_OF_SERVICE',
      ...(apparatus.outOfServiceReason !== undefined
        ? { reason: apparatus.outOfServiceReason }
        : {}),
    };
  }

  const dispatchPk = buildDeptScopedPk(deptId, 'DISPATCH', dispatchId);
  const seatSkValue = seatSk(apparatus.apparatusId, input.positionCode);
  const historySkValue = seatHistSk(
    apparatus.apparatusId,
    input.positionCode,
    input.clientAssignmentId,
  );

  let historyExisting;
  try {
    historyExisting = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: buildDeptScopedPk(deptId, 'DISPATCH', dispatchId), sk: historySkValue },
      }),
    );
  } catch (error) {
    logError('apparatus.ridingBoard.assign.historyCheckFailed', error, { deptId, dispatchId });
    throw new RidingBoardWriteError(error);
  }
  if (historyExisting.Item) {
    const current = await readSeatState(client, tableName, dispatchPk, seatSkValue);
    emitOutcomeMetric(METRICS_NAMESPACE, 'RidingAssignmentReplayed');
    return { kind: 'ALREADY_APPLIED', current };
  }

  const priorSeat = await readSeatState(client, tableName, dispatchPk, seatSkValue);
  const previousMemberId = priorSeat?.memberId ?? null;
  const nextVersion = input.expectedVersion + 1;
  const assignedAt = Math.floor(Date.now() / 1000);
  const eventType =
    input.memberId === null
      ? 'apparatus.riding_assignment.vacated'
      : 'apparatus.riding_assignment.assigned';
  const outboxRecord = buildOutboxRecord(
    deptId,
    'apparatus-service',
    eventType,
    input.clientAssignmentId,
    {
      deptId,
      dispatchId,
      apparatusId: apparatus.apparatusId,
      positionCode: input.positionCode,
      memberId: input.memberId,
      previousMemberId,
      assignedAt,
      assignedBy: input.assignedBy,
    },
  );

  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: tableName,
              Key: {
                pk: buildDeptScopedPk(deptId, 'APPARATUS', apparatus.apparatusId),
                sk: 'METADATA',
              },
              ConditionExpression: '#status = :inService',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: { ':inService': 'IN_SERVICE' },
            },
          },
          {
            Update: {
              TableName: tableName,
              Key: { pk: buildDeptScopedPk(deptId, 'DISPATCH', dispatchId), sk: seatSkValue },
              UpdateExpression:
                'SET entityType = :entityType, apparatusId = :apparatusId, positionCode = :positionCode, memberId = :memberId, version = :nextVersion, assignedAt = :assignedAt, assignedBy = :assignedBy',
              ConditionExpression: 'attribute_not_exists(pk) OR version = :expectedVersion',
              ExpressionAttributeValues: {
                ':entityType': 'RIDING_ASSIGNMENT',
                ':apparatusId': apparatus.apparatusId,
                ':positionCode': input.positionCode,
                ':memberId': input.memberId,
                ':nextVersion': nextVersion,
                ':assignedAt': assignedAt,
                ':assignedBy': input.assignedBy,
                ':expectedVersion': input.expectedVersion,
              },
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: {
                pk: buildDeptScopedPk(deptId, 'DISPATCH', dispatchId),
                sk: historySkValue,
                entityType: 'RIDING_ASSIGNMENT_HISTORY',
                apparatusId: apparatus.apparatusId,
                positionCode: input.positionCode,
                memberId: input.memberId,
                previousMemberId,
                version: nextVersion,
                clientAssignmentId: input.clientAssignmentId,
                assignedAt,
                assignedBy: input.assignedBy,
              },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          { Put: { TableName: tableName, Item: outboxRecord } },
        ],
      }),
    );
  } catch (error) {
    logError('apparatus.ridingBoard.assign.failed', error, {
      deptId,
      dispatchId,
      cancellationReasons:
        error instanceof TransactionCanceledException
          ? (error.CancellationReasons ?? []).map((entry) => entry.Code)
          : undefined,
    });

    if (cancellationCodeAt(error, 0) === 'ConditionalCheckFailed') {
      emitOutcomeMetric(METRICS_NAMESPACE, 'RidingAssignmentOutOfService');
      return { kind: 'OUT_OF_SERVICE' };
    }
    if (cancellationCodeAt(error, 2) === 'ConditionalCheckFailed') {
      const current = await readSeatState(client, tableName, dispatchPk, seatSkValue);
      emitOutcomeMetric(METRICS_NAMESPACE, 'RidingAssignmentReplayed');
      return { kind: 'ALREADY_APPLIED', current };
    }
    if (cancellationCodeAt(error, 1) === 'ConditionalCheckFailed') {
      const current = await readSeatState(client, tableName, dispatchPk, seatSkValue);
      emitOutcomeMetric(METRICS_NAMESPACE, 'RidingAssignmentConflict');
      return { kind: 'CONFLICT', current };
    }
    emitOutcomeMetric(
      METRICS_NAMESPACE,
      'RidingAssignmentFailed',
      error instanceof Error ? error.constructor.name : 'UnknownError',
    );
    throw new RidingBoardWriteError(error);
  }

  emitOutcomeMetric(
    METRICS_NAMESPACE,
    input.memberId === null ? 'RidingAssignmentVacated' : 'RidingAssignmentAssigned',
  );
  return {
    kind: 'ASSIGNED',
    apparatusId: apparatus.apparatusId,
    positionCode: input.positionCode,
    memberId: input.memberId,
    previousMemberId,
    version: nextVersion,
  };
}
