import { randomUUID } from 'node:crypto';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { buildBridgeOutboxRecord } from '../platformBusBridge.js';
import type { DispatchReceived, SourceSystem } from './dispatchIngressPort.js';
import { logError, logInfo } from './logger.js';

export interface CreateManualDispatchInput {
  readonly deptId: VerifiedDeptId;
  readonly dispatch: DispatchReceived;
  readonly idempotencyKey: string;
  readonly dispatchedAt: number;
  readonly targetMemberId?: string;
  readonly selfTestId?: string;
  readonly channelsTested?: readonly string[];
  /** Test dispatches: whether FCM really delivers (channels/channelEnvelope.ts TestDelivery). */
  readonly testDelivery?: 'deliver' | 'validate';
  /** CAD ingress only (cadIngress/ingest.ts): which authenticated source and how it parsed. */
  readonly cad?: CadDispatchTags;
  /**
   * CAD ingress only: the replay marker (cadIngress/replayGuard.ts), written as a conditional
   * item of THIS transaction so marker and dispatch commit together or not at all - a failed
   * write can never leave a marker behind that refuses the sender's retry (chain review M3).
   */
  readonly replayMarker?: Record<string, unknown> & { readonly pk: string; readonly sk: string };
  /**
   * CAD ingress only: when the idempotency lock stops counting (epoch seconds). A later message
   * with the same identity after this time is a NEW dispatch (chain review C1: a text-only
   * identity must never swallow a genuine repeat call forever). Absent = the lock never expires
   * (manual and self-test submissions, unchanged).
   */
  readonly lockExpiresAt?: number;
}

/** How long an expired lock item is kept for the record before the TTL sweeper removes it. */
const EXPIRED_LOCK_RETENTION_SECONDS = 7 * 24 * 60 * 60;

/**
 * Stored on a CAD-originated DISPATCH_ALERT for the record and the dispatch detail. Fan-out
 * reads none of it: a CAD page is the same tone-1 page as any other.
 */
export interface CadDispatchTags {
  readonly ingressChannel: 'cad-email' | 'cad-webhook';
  readonly sourceId: string;
  readonly parseStatus: 'PARSED' | 'RAW';
  readonly parserVersion: number | null;
  /** RAW (fail-open) dispatches: the address is "SEE DISPATCH TEXT" and must be verified. */
  readonly verifyRequired: boolean;
  readonly incidentNumber?: string;
  readonly dispatchTimeText?: string;
  /** Whitespace-insensitive hash of the message text: a resend of it is not an update. */
  readonly contentHash?: string;
}

export type CreateManualDispatchResult =
  | { readonly outcome: 'created'; readonly dispatchId: string }
  | { readonly outcome: 'duplicate' }
  /** The replay marker already existed: this exact message was already written. */
  | { readonly outcome: 'replay' };

const LOCK_ITEM_INDEX = 0;
const TEST_AUDIT_TTL_SECONDS = 60 * 60 * 24 * 365;

function mintDispatchId(
  deptId: VerifiedDeptId,
  dispatchedAt: number,
  sourceSystem: SourceSystem,
): string {
  const kind =
    sourceSystem === 'SELF_TEST' ? 'SELFTEST' : sourceSystem === 'CAD' ? 'CAD' : 'MANUAL';
  return `${deptId}-${kind}-${dispatchedAt}-${randomUUID().slice(0, 8)}`;
}

export async function createManualDispatch(
  client: DynamoDBDocumentClient,
  tableName: string,
  input: CreateManualDispatchInput,
): Promise<CreateManualDispatchResult> {
  const { deptId, dispatch, idempotencyKey, dispatchedAt } = input;
  const dispatchId = mintDispatchId(deptId, dispatchedAt, dispatch.sourceSystem);
  const isTest = dispatch.sourceSystem === 'SELF_TEST';

  const command = new TransactWriteCommand({
    TransactItems: [
      {
        Put: {
          TableName: tableName,
          Item: {
            pk: buildDeptScopedPk(
              deptId,
              'DISPATCH_IDEMPOTENCY',
              dispatch.sourceSystem,
              dispatch.externalDispatchId,
            ),
            sk: 'LOCK',
            entityType: 'DISPATCH_IDEMPOTENCY_LOCK',
            idempotencyKey,
            dispatchId,
            deptId,
            createdAt: dispatchedAt,
            ...(input.lockExpiresAt !== undefined
              ? {
                  expiresAt: input.lockExpiresAt,
                  ttl: input.lockExpiresAt + EXPIRED_LOCK_RETENTION_SECONDS,
                }
              : {}),
          },
          ...(input.lockExpiresAt !== undefined
            ? {
                // An expired lock is no lock: the same identity is now a new dispatch.
                ConditionExpression: 'attribute_not_exists(idempotencyKey) OR expiresAt <= :now',
                ExpressionAttributeValues: { ':now': dispatchedAt },
              }
            : { ConditionExpression: 'attribute_not_exists(idempotencyKey)' }),
        },
      },
      {
        Put: {
          TableName: tableName,
          Item: {
            pk: buildDeptScopedPk(deptId, 'DISPATCH', dispatchId),
            sk: 'METADATA',
            entityType: 'DISPATCH_ALERT',
            dispatchId,
            deptId,
            sourceSystem: dispatch.sourceSystem,
            incidentType: dispatch.incidentType,
            address: dispatch.address,
            crossStreets: dispatch.crossStreets,
            unitsRequested: dispatch.unitsRequested,
            narrative: dispatch.narrative,
            // Additive, for the pre-plan lookup only (fan-out never reads it).
            ...(dispatch.locality ? { locality: dispatch.locality } : {}),
            idempotencyKey,
            dispatchedAt,
            createdAt: dispatchedAt,
            toneLadderStatus: 'ACTIVE',
            currentToneSequence: 1,
            nextToneAt: null,
            isTest,
            ...(input.targetMemberId ? { targetMemberId: input.targetMemberId } : {}),
            ...(input.selfTestId ? { selfTestId: input.selfTestId } : {}),
            ...(input.channelsTested ? { channelsTested: input.channelsTested } : {}),
            ...(isTest && input.testDelivery ? { testDelivery: input.testDelivery } : {}),
            ...(input.cad
              ? {
                  ingressChannel: input.cad.ingressChannel,
                  cadSourceId: input.cad.sourceId,
                  cadParseStatus: input.cad.parseStatus,
                  cadParserVersion: input.cad.parserVersion,
                  verifyRequired: input.cad.verifyRequired,
                  ...(input.cad.incidentNumber
                    ? { cadIncidentNumber: input.cad.incidentNumber }
                    : {}),
                  ...(input.cad.dispatchTimeText
                    ? { cadDispatchTime: input.cad.dispatchTimeText }
                    : {}),
                  ...(input.cad.contentHash ? { cadContentHash: input.cad.contentHash } : {}),
                }
              : {}),
            ...(isTest
              ? { ttl: dispatchedAt + TEST_AUDIT_TTL_SECONDS }
              : { gsi2pk: buildDeptScopedPk(deptId), gsi2sk: `DISPATCH#${dispatchedAt}` }),
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
      // INVARIANT: every writer of a non-test DISPATCH_ALERT must emit
      // dispatch.alert.received in the SAME transaction. This function is the only
      // DISPATCH_ALERT writer today (MANUAL, CAD, SELF_TEST all come through here),
      // despite its name - CAD email and webhook ingress reach it through
      // cadIngress/ingest.ts. A future ingress path (e.g. /ingress/{adapter}) that writes
      // DISPATCH_ALERT any other way would silently skip the platform-bus bridge,
      // so the alert pages but no incident draft is ever pre-populated. SELF_TEST is
      // excluded on purpose: a member self-test must never reach the LOB bus.
      ...(isTest
        ? []
        : [
            {
              Put: {
                TableName: tableName,
                Item: buildBridgeOutboxRecord(deptId, 'dispatch.alert.received', dispatchId, {
                  deptId,
                  dispatchId,
                  incidentType: dispatch.incidentType,
                  address: dispatch.address,
                  crossStreets: dispatch.crossStreets,
                  narrative: dispatch.narrative,
                  dispatchedAt,
                  // Additive and optional, so schemaVersion stays 1.0: present only for a RAW
                  // (fail-open) CAD dispatch, whose address is the "SEE DISPATCH TEXT"
                  // placeholder. The LOB incident plane's dispatch copy shows VERIFY on it.
                  ...(input.cad?.verifyRequired === true ? { verifyRequired: true } : {}),
                }),
              },
            },
          ]),
      ...(input.replayMarker
        ? [
            {
              Put: {
                TableName: tableName,
                Item: input.replayMarker,
                // An expired marker the TTL sweeper has not deleted yet is no marker.
                ConditionExpression: 'attribute_not_exists(pk) OR #ttl <= :replayNow',
                ExpressionAttributeNames: { '#ttl': 'ttl' },
                ExpressionAttributeValues: { ':replayNow': input.replayMarker.createdAt },
              },
            },
          ]
        : []),
    ],
  });
  const replayIndex = (command.input.TransactItems?.length ?? 0) - 1;

  try {
    await client.send(command);
    return { outcome: 'created', dispatchId };
  } catch (error) {
    if (error instanceof TransactionCanceledException) {
      if (
        input.replayMarker &&
        error.CancellationReasons?.[replayIndex]?.Code === 'ConditionalCheckFailed'
      ) {
        return { outcome: 'replay' };
      }
      const lockReason = error.CancellationReasons?.[LOCK_ITEM_INDEX];
      if (lockReason?.Code === 'ConditionalCheckFailed') {
        logInfo('dispatches.create.duplicate', {
          deptId,
          externalDispatchId: dispatch.externalDispatchId,
          cancellationReasons: error.CancellationReasons,
        });
        return { outcome: 'duplicate' };
      }
    }
    logError('dispatches.create.failed', error, {
      deptId,
      externalDispatchId: dispatch.externalDispatchId,
    });
    throw error;
  }
}

export interface DispatchAlertItem {
  readonly dispatchId: string;
  // TODO(E1-S2): joined onto DISPATCH_ALERT by fan-out ingress (architecture Backend
  // §1.4); createManualDispatch below does not write it — no ingress path in this repo
  // does yet.
  readonly occupancyId?: string;
}

export class DispatchLookupDependencyError extends Error {
  readonly reason: string;

  constructor(cause: unknown) {
    super('DynamoDB is unavailable or returned an unexpected error');
    this.name = 'DispatchLookupDependencyError';
    this.cause = cause;
    this.reason = cause instanceof Error ? cause.constructor.name : 'UnknownError';
  }
}

export async function getDispatchById(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
): Promise<DispatchAlertItem | undefined> {
  try {
    const output = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: buildDeptScopedPk(deptId, 'DISPATCH', dispatchId), sk: 'METADATA' },
      }),
    );
    return output.Item as DispatchAlertItem | undefined;
  } catch (error) {
    logError('dispatches.get.failed', error, { deptId, dispatchId });
    throw new DispatchLookupDependencyError(error);
  }
}
