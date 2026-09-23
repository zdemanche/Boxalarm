import { randomUUID } from 'node:crypto';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

export type ShiftSwapStatus = 'PENDING' | 'APPROVED' | 'DENIED';

export interface ShiftSwapRequestRecord {
  readonly positionCode: string;
  readonly fromMemberId: string;
  readonly toMemberId: string;
  readonly status: ShiftSwapStatus;
  readonly requiresOfficerApproval: boolean;
  readonly requestedAt: number;
}

export type ProposeSwapOutcome =
  | {
      readonly kind: 'PROPOSED';
      readonly requestedAt: number;
      readonly requiresOfficerApproval: boolean;
    }
  | { readonly kind: 'POSITION_NOT_FOUND' }
  | { readonly kind: 'NOT_CLAIMED_BY_YOU' };

export type ApproveSwapOutcome =
  | { readonly kind: 'APPROVED'; readonly toMemberId: string }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'NOT_PENDING' }
  | { readonly kind: 'POSITION_CONFLICT' };

export class ShiftSwapWriteError extends Error {
  readonly reason: string;

  constructor(cause: unknown) {
    super('DynamoDB write for the shift swap failed');
    this.name = 'ShiftSwapWriteError';
    this.cause = cause;
    this.reason = cause instanceof Error ? cause.constructor.name : 'UnknownError';
  }
}

export async function readShiftSwapConfig(
  doc: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
): Promise<{ readonly requiresOfficerApproval: boolean }> {
  const result = await doc.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: buildDeptScopedPk(deptId), sk: 'CONFIG#SHIFT_RULES' },
    }),
  );
  const value = result.Item?.value as Record<string, unknown> | undefined;
  const flag = value?.requiresOfficerApproval;
  return { requiresOfficerApproval: typeof flag === 'boolean' ? flag : true };
}

export async function getShiftSwapRequest(
  doc: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  shiftId: string,
  requestedAt: number,
): Promise<ShiftSwapRequestRecord | undefined> {
  const result = await doc.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: buildDeptScopedPk(deptId, 'SHIFT', shiftId), sk: `SWAP#${requestedAt}` },
    }),
  );
  const item = result.Item;
  if (!item) {
    return undefined;
  }
  return {
    positionCode: String(item.positionCode),
    fromMemberId: String(item.fromMemberId),
    toMemberId: String(item.toMemberId),
    status: item.status as ShiftSwapStatus,
    requiresOfficerApproval: item.requiresOfficerApproval !== false,
    requestedAt: Number(item.requestedAt),
  };
}

function cancellationReasonCodes(error: TransactionCanceledException): (string | undefined)[] {
  return error.CancellationReasons?.map((reason) => reason.Code) ?? [];
}

export async function proposeShiftSwap(
  doc: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  shiftId: string,
  positionCode: string,
  fromMemberId: string,
  toMemberId: string,
): Promise<ProposeSwapOutcome> {
  const pk = buildDeptScopedPk(deptId, 'SHIFT', shiftId);
  const positionSk = `POSITION#${positionCode}`;
  const { requiresOfficerApproval } = await readShiftSwapConfig(doc, tableName, deptId);
  const requestedAt = Date.now();
  const eventId = randomUUID();

  try {
    await doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: tableName,
              Key: { pk, sk: positionSk },
              ConditionExpression: 'claimedByMemberId = :fromMemberId',
              ExpressionAttributeValues: { ':fromMemberId': fromMemberId },
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: {
                pk,
                sk: `SWAP#${requestedAt}`,
                entityType: 'SHIFT_SWAP_REQUEST',
                shiftId,
                positionCode,
                fromMemberId,
                toMemberId,
                status: 'PENDING',
                requiresOfficerApproval,
                requestedAt,
              },
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: {
                pk: buildDeptScopedPk(deptId, 'OUTBOX', fromMemberId),
                sk: `EVT#${eventId}`,
                entityType: 'OUTBOX_ENTRY',
                eventId,
                eventTime: new Date(requestedAt).toISOString(),
                eventType: 'personnel.shift.swap_requested',
                source: 'personnel-service',
                correlationId: shiftId,
                schemaVersion: '1.0',
                deptId,
                memberId: fromMemberId,
                payload: { shiftId, positionCode, fromMemberId, toMemberId, deptId },
                sentAt: null,
              },
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (!(error instanceof TransactionCanceledException)) {
      throw new ShiftSwapWriteError(error);
    }

    const reasons = cancellationReasonCodes(error);
    if (reasons[0] !== 'ConditionalCheckFailed') {
      throw new ShiftSwapWriteError(error);
    }

    const existing = await doc.send(
      new GetCommand({ TableName: tableName, Key: { pk, sk: positionSk } }),
    );
    if (!existing.Item) {
      return { kind: 'POSITION_NOT_FOUND' };
    }
    return { kind: 'NOT_CLAIMED_BY_YOU' };
  }

  return { kind: 'PROPOSED', requestedAt, requiresOfficerApproval };
}

export async function approveShiftSwap(
  doc: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  shiftId: string,
  requestedAt: number,
): Promise<ApproveSwapOutcome> {
  const pk = buildDeptScopedPk(deptId, 'SHIFT', shiftId);
  const swap = await getShiftSwapRequest(doc, tableName, deptId, shiftId, requestedAt);
  if (!swap) {
    return { kind: 'NOT_FOUND' };
  }
  if (swap.status !== 'PENDING') {
    return { kind: 'NOT_PENDING' };
  }

  const positionSk = `POSITION#${swap.positionCode}`;
  const shiftMetadata = await doc.send(
    new GetCommand({ TableName: tableName, Key: { pk, sk: 'METADATA' }, ConsistentRead: true }),
  );
  const startAt: unknown = shiftMetadata.Item?.startAt;
  const gsi1sk = typeof startAt === 'number' ? `SHIFT_POSITION#${startAt}` : undefined;
  const approvedAt = Date.now();
  const eventId = randomUUID();

  try {
    await doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tableName,
              Key: { pk, sk: `SWAP#${requestedAt}` },
              ConditionExpression: '#status = :pending',
              UpdateExpression: 'SET #status = :approved',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: { ':pending': 'PENDING', ':approved': 'APPROVED' },
            },
          },
          {
            Update: {
              TableName: tableName,
              Key: { pk, sk: positionSk },
              ConditionExpression: 'claimedByMemberId = :fromMemberId',
              UpdateExpression:
                gsi1sk === undefined
                  ? 'SET claimedByMemberId = :toMemberId, claimedAt = :claimedAt'
                  : 'SET claimedByMemberId = :toMemberId, claimedAt = :claimedAt, gsi1pk = :gsi1pk, gsi1sk = :gsi1sk',
              ExpressionAttributeValues: {
                ':fromMemberId': swap.fromMemberId,
                ':toMemberId': swap.toMemberId,
                ':claimedAt': approvedAt,
                ...(gsi1sk === undefined
                  ? {}
                  : { ':gsi1pk': `MEMBER#${swap.toMemberId}`, ':gsi1sk': gsi1sk }),
              },
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: {
                pk: buildDeptScopedPk(deptId, 'OUTBOX', swap.toMemberId),
                sk: `EVT#${eventId}`,
                entityType: 'OUTBOX_ENTRY',
                eventId,
                eventTime: new Date(approvedAt).toISOString(),
                eventType: 'personnel.shift.swap_approved',
                source: 'personnel-service',
                correlationId: shiftId,
                schemaVersion: '1.0',
                deptId,
                memberId: swap.toMemberId,
                payload: {
                  shiftId,
                  positionCode: swap.positionCode,
                  fromMemberId: swap.fromMemberId,
                  toMemberId: swap.toMemberId,
                  deptId,
                },
                sentAt: null,
              },
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (!(error instanceof TransactionCanceledException)) {
      throw new ShiftSwapWriteError(error);
    }

    const reasons = cancellationReasonCodes(error);
    if (reasons[0] === 'ConditionalCheckFailed') {
      return { kind: 'NOT_PENDING' };
    }
    if (reasons[1] === 'ConditionalCheckFailed') {
      return { kind: 'POSITION_CONFLICT' };
    }
    throw new ShiftSwapWriteError(error);
  }

  return { kind: 'APPROVED', toMemberId: swap.toMemberId };
}
