import { createHash, randomUUID } from 'node:crypto';
import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { buildBridgeOutboxRecord } from '../platformBusBridge.js';
import type { AckStatus } from '../dispatchRosterEntry.js';
import { parseSnapshotItem } from '../eligibility/selector.js';
import { logError, logInfo } from '../dispatches/logger.js';

export type ResponseAckStatus = Exclude<AckStatus, 'NONE'>;

export interface RecordResponseInput {
  readonly deptId: VerifiedDeptId;
  readonly dispatchId: string;
  readonly memberId: string;
  readonly ackStatus: ResponseAckStatus;
  /** Expected arrival time, epoch seconds; null when unknown (always null for NOT_RESPONDING). */
  readonly eta: number | null;
  readonly assignedApparatusId: string | null;
  /** Epoch seconds the member answered: DISPATCH_RESPONSE_RECORD.answeredAt, roster ackAt. */
  readonly answeredAt: number;
  /**
   * Epoch ms the member answered, the roster's ordering key; defaults to answeredAt * 1000.
   * Seconds were too coarse: a member who changed their answer within the same second had the
   * change dropped from the live roster while still being told it was recorded.
   */
  readonly answeredAtMs?: number;
  /** Epoch ms the server received it: breaks a tie on answeredAtMs. Defaults to now. */
  readonly receivedAtMs?: number;
  /**
   * The client's id for this answer. A retry with the same id (the app re-sending after a lost
   * response) is recorded once and answered with the original outcome; per member, per
   * dispatch, per id. Reusing an id for a different answer is a conflict.
   */
  readonly clientAnswerId?: string;
}

/** The answer as first recorded - what a replay is answered with. */
export interface RecordedAnswer {
  readonly ackStatus: ResponseAckStatus;
  readonly eta: number | null;
  readonly assignedApparatusId: string | null;
  readonly answeredAt: number;
}

/**
 * APPLIED: the answer is the member's current one on the live roster. SUPERSEDED: it is kept in
 * the append-only audit record, but a later answer is already on the roster, so the roster did
 * not change - the member must not be told their answer is showing when it is not.
 */
export type RosterOutcome = 'APPLIED' | 'SUPERSEDED';

export type RecordResponseResult =
  | {
      readonly outcome: 'recorded';
      readonly roster: RosterOutcome;
      readonly answer: RecordedAnswer;
      readonly replayed: boolean;
    }
  | { readonly outcome: 'answer-id-conflict' }
  | { readonly outcome: 'dispatch-not-found' }
  | { readonly outcome: 'ineligible' };

/** Replay guards outlive any client retry by far; the answer's audit record is permanent. */
const ANSWER_GUARD_TTL_SECONDS = 7 * 24 * 60 * 60;

function requestFingerprint(input: RecordResponseInput): string {
  return createHash('sha256')
    .update(JSON.stringify([input.ackStatus, input.eta, input.assignedApparatusId]))
    .digest('hex');
}

function answerGuardSk(memberId: string, clientAnswerId: string): string {
  return `RESPONSEKEY#${memberId}#${clientAnswerId}`;
}

interface OrderedAnswer extends RecordedAnswer {
  readonly answeredAtMs: number;
  readonly receivedAtMs: number;
}

export async function recordResponse(
  client: DynamoDBDocumentClient,
  tableName: string,
  input: RecordResponseInput,
): Promise<RecordResponseResult> {
  const { deptId, dispatchId, memberId, clientAnswerId } = input;
  const pk = buildDeptScopedPk(deptId, 'DISPATCH', dispatchId);

  const dispatch = await client.send(
    new GetCommand({ TableName: tableName, Key: { pk, sk: 'METADATA' } }),
  );
  if (!dispatch.Item) {
    return { outcome: 'dispatch-not-found' };
  }
  const toneSequence = (dispatch.Item.currentToneSequence as number | undefined) ?? 1;

  const eligibility = await client.send(
    new GetCommand({
      TableName: tableName,
      Key: {
        pk: buildDeptScopedPk(deptId, 'ELIGIBILITY'),
        sk: `MEMBER#${memberId}`,
      },
    }),
  );
  const snapshot = parseSnapshotItem(eligibility.Item as Record<string, unknown> | undefined);
  if (!snapshot || !snapshot.active) {
    logInfo('responses.record.ineligible', { deptId, dispatchId, memberId });
    return { outcome: 'ineligible' };
  }

  const answer: OrderedAnswer = {
    ackStatus: input.ackStatus,
    eta: input.eta,
    assignedApparatusId: input.assignedApparatusId,
    answeredAt: input.answeredAt,
    answeredAtMs: input.answeredAtMs ?? input.answeredAt * 1000,
    receivedAtMs: input.receivedAtMs ?? Date.now(),
  };
  const fingerprint = requestFingerprint(input);
  const isTest = dispatch.Item.isTest === true;

  try {
    await writeAnswer(client, tableName, input, answer, pk, toneSequence, isTest, fingerprint);
  } catch (error) {
    const replay =
      clientAnswerId !== undefined &&
      error instanceof TransactionCanceledException &&
      error.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed';
    if (!replay) {
      throw error;
    }
    return replayAnswer(client, tableName, input, pk, fingerprint, snapshot.quals, toneSequence);
  }

  const roster = await applyToRoster(
    client,
    tableName,
    input,
    answer,
    pk,
    snapshot.quals,
    toneSequence,
  );
  if (clientAnswerId !== undefined) {
    await recordGuardOutcome(client, tableName, pk, memberId, clientAnswerId, roster);
  }
  return { outcome: 'recorded', roster, answer, replayed: false };
}

/**
 * The append-only answer record, its platform-bus bridge row and - when the client sent an
 * answer id - the replay guard, in one transaction: a replay collides on the guard (index 0)
 * and writes nothing, so it never adds a second record or a second alerting.response.confirmed.
 */
async function writeAnswer(
  client: DynamoDBDocumentClient,
  tableName: string,
  input: RecordResponseInput,
  answer: OrderedAnswer,
  pk: string,
  toneSequence: number,
  isTest: boolean,
  fingerprint: string,
): Promise<void> {
  const { deptId, dispatchId, memberId, clientAnswerId } = input;
  // Always suffixed, so two answers in the same second are two records, never one overwrite.
  const answerId = clientAnswerId ?? `srv-${randomUUID()}`;
  await client.send(
    new TransactWriteCommand({
      TransactItems: [
        ...(clientAnswerId === undefined
          ? []
          : [
              {
                Put: {
                  TableName: tableName,
                  Item: {
                    pk,
                    sk: answerGuardSk(memberId, clientAnswerId),
                    entityType: 'DISPATCH_RESPONSE_ANSWER_GUARD',
                    memberId,
                    requestFingerprint: fingerprint,
                    ackStatus: answer.ackStatus,
                    eta: answer.eta,
                    assignedApparatusId: answer.assignedApparatusId,
                    answeredAt: answer.answeredAt,
                    answeredAtMs: answer.answeredAtMs,
                    receivedAtMs: answer.receivedAtMs,
                    ttl: answer.answeredAt + ANSWER_GUARD_TTL_SECONDS,
                  },
                  ConditionExpression: 'attribute_not_exists(pk)',
                },
              },
            ]),
        {
          Put: {
            TableName: tableName,
            Item: {
              pk,
              sk: `RESPONSE#${memberId}#${answer.answeredAt}#${answerId}`,
              entityType: 'DISPATCH_RESPONSE_RECORD',
              memberId,
              ackStatus: answer.ackStatus,
              toneSequence,
              eta: answer.eta,
              assignedApparatusId: answer.assignedApparatusId,
              answeredAt: answer.answeredAt,
              answeredAtMs: answer.answeredAtMs,
              receivedAtMs: answer.receivedAtMs,
              ...(clientAnswerId !== undefined ? { clientAnswerId } : {}),
            },
          },
        },
        ...(isTest
          ? []
          : [
              {
                Put: {
                  TableName: tableName,
                  Item: buildBridgeOutboxRecord(deptId, 'alerting.response.confirmed', dispatchId, {
                    deptId,
                    dispatchId,
                    memberId,
                    status: answer.ackStatus,
                    ackAt: answer.answeredAt,
                  }),
                },
              },
            ]),
      ],
    }),
  );
}

/**
 * Last answer wins on the live roster, ordered by when the member answered (ms), then by when
 * the server received it. A roster row written before ms ordering existed carries only ackAt
 * (seconds); an answer in the same or a later second replaces it.
 */
async function applyToRoster(
  client: DynamoDBDocumentClient,
  tableName: string,
  input: RecordResponseInput,
  answer: OrderedAnswer,
  pk: string,
  quals: readonly string[],
  toneSequence: number,
): Promise<RosterOutcome> {
  const { deptId, dispatchId, memberId } = input;
  try {
    await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { pk, sk: `ROSTER#${memberId}` },
        // currentChannelTier / escalationLevel seeded where absent: an answer can land before the
        // fan-out seeds the row, and the escalation handler requires both (review MAJOR-1).
        UpdateExpression:
          'SET entityType = :entityType, memberId = :memberId, ackStatus = :ackStatus, ackAt = :ackAt, ackAtMs = :ackAtMs, ackReceivedAtMs = :receivedAtMs, eta = :eta, assignedApparatusId = :assignedApparatusId, lastAnsweredTone = :toneSequence, quals = :quals, currentChannelTier = if_not_exists(currentChannelTier, :primary), escalationLevel = if_not_exists(escalationLevel, :zero)',
        ConditionExpression:
          '(attribute_not_exists(ackAtMs) AND (attribute_not_exists(ackAt) OR :ackAt >= ackAt)) OR :ackAtMs > ackAtMs OR (:ackAtMs = ackAtMs AND :receivedAtMs > ackReceivedAtMs)',
        ExpressionAttributeValues: {
          ':entityType': 'DISPATCH_ROSTER_ENTRY',
          ':memberId': memberId,
          ':ackStatus': answer.ackStatus,
          ':ackAt': answer.answeredAt,
          ':ackAtMs': answer.answeredAtMs,
          ':receivedAtMs': answer.receivedAtMs,
          ':eta': answer.eta,
          ':assignedApparatusId': answer.assignedApparatusId,
          ':toneSequence': toneSequence,
          ':quals': quals,
          ':primary': 'primary',
          ':zero': 0,
        },
      }),
    );
    return 'APPLIED';
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      logInfo('responses.record.superseded', { deptId, dispatchId, memberId });
      return 'SUPERSEDED';
    }
    logError('responses.record.roster_update_failed', error, { deptId, dispatchId, memberId });
    throw error;
  }
}

/** Remembers the roster outcome on the guard so a replay answers exactly as the original. */
async function recordGuardOutcome(
  client: DynamoDBDocumentClient,
  tableName: string,
  pk: string,
  memberId: string,
  clientAnswerId: string,
  roster: RosterOutcome,
): Promise<void> {
  try {
    await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { pk, sk: answerGuardSk(memberId, clientAnswerId) },
        UpdateExpression: 'SET rosterOutcome = :roster',
        ExpressionAttributeValues: { ':roster': roster },
      }),
    );
  } catch (error) {
    // A replay without it re-applies the stored answer, which gives the same outcome.
    logError('responses.record.guard_outcome_write_failed', error, { memberId });
  }
}

/**
 * A retry of an answer already written. The same answer is answered with the original outcome;
 * if the original attempt died before reaching the roster, the stored answer is applied now.
 * A different answer under the same id is a conflict and changes nothing.
 */
async function replayAnswer(
  client: DynamoDBDocumentClient,
  tableName: string,
  input: RecordResponseInput,
  pk: string,
  fingerprint: string,
  quals: readonly string[],
  toneSequence: number,
): Promise<RecordResponseResult> {
  const { deptId, dispatchId, memberId } = input;
  const clientAnswerId = input.clientAnswerId!;
  const { Item: guard } = await client.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk, sk: answerGuardSk(memberId, clientAnswerId) },
      ConsistentRead: true,
    }),
  );
  if (!guard || guard.requestFingerprint !== fingerprint) {
    logInfo('responses.record.answer_id_conflict', { deptId, dispatchId, memberId });
    return { outcome: 'answer-id-conflict' };
  }
  const stored: OrderedAnswer = {
    ackStatus: guard.ackStatus as ResponseAckStatus,
    eta: (guard.eta as number | null | undefined) ?? null,
    assignedApparatusId: (guard.assignedApparatusId as string | null | undefined) ?? null,
    answeredAt: guard.answeredAt as number,
    answeredAtMs: guard.answeredAtMs as number,
    receivedAtMs: guard.receivedAtMs as number,
  };
  let roster = guard.rosterOutcome as RosterOutcome | undefined;
  if (roster === undefined) {
    roster = await applyToRoster(client, tableName, input, stored, pk, quals, toneSequence);
    await recordGuardOutcome(client, tableName, pk, memberId, clientAnswerId, roster);
  }
  logInfo('responses.record.replayed', { deptId, dispatchId, memberId, roster });
  return {
    outcome: 'recorded',
    roster,
    answer: {
      ackStatus: stored.ackStatus,
      eta: stored.eta,
      assignedApparatusId: stored.assignedApparatusId,
      answeredAt: stored.answeredAt,
    },
    replayed: true,
  };
}
