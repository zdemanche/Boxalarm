import { createHash } from 'node:crypto';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { resolveCadMessageTime } from '@boxalarm/cad-parser';
import type { DispatchReceived } from '../dispatches/dispatchIngressPort.js';
import type { CadChannel } from './metrics.js';

/**
 * A later CAD message for an incident already paged is an UPDATE, not a new dispatch
 * (docs/decisions/2026-09-30-cad-dispatch-updates.md). One transaction:
 *   0. DISPATCH_UPDATE `UPDATE#{updateId}` on the dispatch's partition (history), conditional
 *      on not existing - the updateId is the content hash, so an identical resend of the same
 *      update is a duplicate and notifies nobody twice;
 *   1. the DISPATCH_ALERT itself, refreshed where the CAD changed it, conditional on its
 *      stored content hash differing (a resend of the ORIGINAL message is a duplicate too);
 *   2. the message's replay marker (same all-or-nothing rule as a new dispatch).
 * No bridge outbox row (the incident draft already exists) and no new tone ladder. The
 * non-escalating UPDATE push is sent by cadIngress/updateNotifierHandler.ts from the stream
 * INSERT of item 0 - the same single-producer shape as the tone-1 fan-out.
 */

export type UpdatedField =
  'incidentType' | 'address' | 'crossStreets' | 'unitsRequested' | 'narrative';

export interface CadFieldChange {
  readonly field: UpdatedField;
  readonly from: string;
  readonly to: string;
}

type ResolvedUpdateInput = RecordUpdateInput & { readonly messageTime?: number | undefined };

export type RecordUpdateResult =
  | { readonly outcome: 'recorded'; readonly updateId: string; readonly changes: CadFieldChange[] }
  /** An older CAD message: kept in the history, nothing applied, nobody notified (R2-M1). */
  | { readonly outcome: 'history'; readonly updateId: string }
  | { readonly outcome: 'duplicate' }
  | { readonly outcome: 'replay' }
  /** The lock pointed at a dispatch that is gone: the caller treats the message as new. */
  | { readonly outcome: 'missing' };

export interface RecordUpdateInput {
  readonly deptId: VerifiedDeptId;
  readonly dispatchId: string;
  readonly dispatch: DispatchReceived;
  readonly parseStatus: 'PARSED' | 'RAW';
  readonly contentHash: string;
  readonly channel: CadChannel;
  readonly receivedAt: number;
  /** The CAD's own dispatch/message time as the template read it (free text). */
  readonly messageTimeText?: string;
  /** The department's time zone, for resolving that text (resolveCadMessageTime). */
  readonly timeZone: string;
  readonly replayMarker?: Record<string, unknown> & { readonly pk: string; readonly sk: string };
}

const NARRATIVE_SUMMARY_CHARS = 120;

export function updateIdFor(contentHash: string): string {
  return createHash('sha256').update(`UPDATE|${contentHash}`).digest('hex').slice(0, 32);
}

function asText(value: unknown): string {
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string').join(', ');
  return typeof value === 'string' ? value : '';
}

/** What this update changes, field by field, against the dispatch as stored now. */
export function diffDispatch(
  current: Record<string, unknown>,
  next: DispatchReceived,
  parseStatus: 'PARSED' | 'RAW',
): CadFieldChange[] {
  // A RAW update carries only text: it never overwrites a structured address with the
  // "SEE DISPATCH TEXT" placeholder. Its text becomes the narrative.
  const candidates: [UpdatedField, string][] =
    parseStatus === 'PARSED'
      ? [
          ['incidentType', next.incidentType],
          ['address', next.address],
          ['crossStreets', next.crossStreets],
          ['unitsRequested', next.unitsRequested.join(', ')],
          ['narrative', next.narrative],
        ]
      : [['narrative', next.narrative]];
  return candidates
    .filter(([field, to]) => to.length > 0 && asText(current[field]) !== to)
    .map(([field, to]) => ({ field, from: asText(current[field]), to }));
}

const LABELS: Record<UpdatedField, string> = {
  incidentType: 'Type',
  address: 'Address',
  crossStreets: 'Cross streets',
  unitsRequested: 'Units',
  narrative: 'Narrative',
};

/** One line for the push: the structured changes first, the narrative only when alone. */
export function summarizeChanges(changes: readonly CadFieldChange[]): string {
  const structured = changes.filter((c) => c.field !== 'narrative');
  if (structured.length > 0) {
    return structured.map((c) => `${LABELS[c.field]}: ${c.to}`).join('; ');
  }
  const narrative = changes.find((c) => c.field === 'narrative')?.to ?? '';
  return narrative.length > NARRATIVE_SUMMARY_CHARS
    ? `${narrative.slice(0, NARRATIVE_SUMMARY_CHARS - 1)}…`
    : narrative || 'New dispatch text';
}

/**
 * The per-incident record that a message's content was accepted (created the dispatch or was
 * recorded as an update). Chain review R2-M1: only the alert's CURRENT hash used to be kept, so
 * the original message arriving again after a correction was applied as an update and reverted
 * it. Every accepted content leaves one of these, written in the same transaction, so any
 * message seen before is a duplicate.
 */
export function seenContentKey(pk: string, contentHash: string): { pk: string; sk: string } {
  return { pk, sk: `SEEN#${contentHash}` };
}

/**
 * An update that still owes its crew an UPDATE push: written with the update, deleted by the
 * notifier once every member is notified. The sweep (updateSweepHandler.ts) re-drives any that
 * linger and alarms on old ones - the only record of an update whose hand-off never happened
 * (the ingress Lambda died between commit and invoke).
 */
export function pendingNoticeKey(
  deptId: VerifiedDeptId,
  receivedAt: number,
  dispatchId: string,
  updateId: string,
): { pk: string; sk: string } {
  return {
    pk: buildDeptScopedPk(deptId, 'CAD_UPDATE_PENDING'),
    sk: `${String(receivedAt).padStart(12, '0')}#${dispatchId}#${updateId}`,
  };
}

export const PENDING_NOTICE_RETENTION_SECONDS = 7 * 24 * 60 * 60;

export async function recordCadUpdate(
  client: DynamoDBDocumentClient,
  tableName: string,
  request: RecordUpdateInput,
): Promise<RecordUpdateResult> {
  let input: ResolvedUpdateInput = request;
  const pk = buildDeptScopedPk(input.deptId, 'DISPATCH', input.dispatchId);
  const { Item: current } = await client.send(
    new GetCommand({ TableName: tableName, Key: { pk, sk: 'METADATA' }, ConsistentRead: true }),
  );
  if (!current) return { outcome: 'missing' };
  if (current.cadContentHash === input.contentHash) return { outcome: 'duplicate' };

  // A message the CAD stamped EARLIER than the one last applied (a delayed email, a re-signed
  // retry of the original) is history only: it never reverts newer fields and never pushes.
  // A bare time is placed nearest THIS message's receipt (a bare 0003 after 2355 is the next
  // day, chain review R3-M1; an update 13.5 h into a long incident is today, R3b-M1), then
  // compared with the stored one; a time that does not resolve leaves the message unordered.
  const appliedTime =
    typeof current.cadMessageTime === 'number' ? current.cadMessageTime : undefined;
  const messageTime = resolveCadMessageTime(input.messageTimeText, {
    receivedAt: input.receivedAt,
    timeZone: input.timeZone,
  });
  input = { ...input, messageTime };
  const olderThanApplied =
    input.messageTime !== undefined && appliedTime !== undefined && input.messageTime < appliedTime;
  const result = await writeUpdate(client, tableName, pk, current, input, olderThanApplied);
  if (result === 'raced' && !olderThanApplied) {
    // A newer message was applied between the read and the write: record this one as history.
    const reread = await client.send(
      new GetCommand({ TableName: tableName, Key: { pk, sk: 'METADATA' }, ConsistentRead: true }),
    );
    const again = await writeUpdate(client, tableName, pk, reread.Item ?? current, input, true);
    return again === 'raced' ? { outcome: 'duplicate' } : again;
  }
  return result === 'raced' ? { outcome: 'duplicate' } : result;
}

async function writeUpdate(
  client: DynamoDBDocumentClient,
  tableName: string,
  pk: string,
  current: Record<string, unknown>,
  input: ResolvedUpdateInput,
  historyOnly: boolean,
): Promise<RecordUpdateResult | 'raced'> {
  const changes = historyOnly ? [] : diffDispatch(current, input.dispatch, input.parseStatus);
  const updateId = updateIdFor(input.contentHash);
  const next = input.dispatch;
  const set: string[] = [
    'cadContentHash = :hash',
    'lastUpdateId = :updateId',
    'lastUpdatedAt = :now',
    'updateCount = if_not_exists(updateCount, :zero) + :one',
  ];
  const values: Record<string, unknown> = {
    ':hash': input.contentHash,
    ':updateId': updateId,
    ':now': input.receivedAt,
    ':zero': 0,
    ':one': 1,
  };
  for (const change of changes) {
    set.push(`${change.field} = :${change.field}`);
    values[`:${change.field}`] =
      change.field === 'unitsRequested' ? next.unitsRequested : change.to;
  }
  if (input.parseStatus === 'PARSED') {
    // A structured update resolves a RAW (VERIFY) page: the CAD has now sent the address.
    set.push('cadParseStatus = :parsed', 'verifyRequired = :false');
    values[':parsed'] = 'PARSED';
    values[':false'] = false;
    if (next.locality) {
      set.push('locality = :locality');
      values[':locality'] = next.locality;
    }
  }
  let condition = 'attribute_exists(pk)';
  if (input.messageTime !== undefined) {
    set.push('cadMessageTime = :mt');
    values[':mt'] = input.messageTime;
    // Never apply over a newer message that landed after our read.
    condition += ' AND (attribute_not_exists(cadMessageTime) OR cadMessageTime <= :mt)';
  }

  const items: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']> =
    [
      {
        Put: {
          TableName: tableName,
          Item: {
            pk,
            sk: `UPDATE#${updateId}`,
            entityType: 'DISPATCH_UPDATE',
            deptId: input.deptId,
            dispatchId: input.dispatchId,
            updateId,
            receivedAt: input.receivedAt,
            ingressChannel: input.channel,
            parseStatus: input.parseStatus,
            changes,
            summary: historyOnly ? 'Older CAD message - not applied' : summarizeChanges(changes),
            applied: !historyOnly,
            ...(input.messageTime !== undefined ? { messageTime: input.messageTime } : {}),
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
      {
        Put: {
          TableName: tableName,
          Item: {
            ...seenContentKey(pk, input.contentHash),
            entityType: 'CAD_SEEN_CONTENT',
            deptId: input.deptId,
            dispatchId: input.dispatchId,
            createdAt: input.receivedAt,
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
      ...(historyOnly
        ? []
        : [
            {
              Put: {
                TableName: tableName,
                Item: {
                  ...pendingNoticeKey(input.deptId, input.receivedAt, input.dispatchId, updateId),
                  entityType: 'CAD_UPDATE_PENDING',
                  deptId: input.deptId,
                  dispatchId: input.dispatchId,
                  updateId,
                  receivedAt: input.receivedAt,
                  ttl: input.receivedAt + PENDING_NOTICE_RETENTION_SECONDS,
                },
              },
            },
            {
              Update: {
                TableName: tableName,
                Key: { pk, sk: 'METADATA' },
                UpdateExpression: `SET ${set.join(', ')}`,
                ConditionExpression: condition,
                ExpressionAttributeValues: values,
              },
            },
          ]),
      ...(input.replayMarker
        ? [
            {
              Put: {
                TableName: tableName,
                Item: input.replayMarker,
                ConditionExpression: 'attribute_not_exists(pk) OR #ttl <= :replayNow',
                ExpressionAttributeNames: { '#ttl': 'ttl' },
                ExpressionAttributeValues: { ':replayNow': input.replayMarker.createdAt },
              },
            },
          ]
        : []),
    ];
  try {
    await client.send(new TransactWriteCommand({ TransactItems: items }));
    return historyOnly
      ? { outcome: 'history', updateId }
      : { outcome: 'recorded', updateId, changes };
  } catch (error) {
    if (error instanceof TransactionCanceledException) {
      const reasons = error.CancellationReasons ?? [];
      const failed = (index: number) => reasons[index]?.Code === 'ConditionalCheckFailed';
      const markerIndex = items.length - 1;
      if (input.replayMarker && failed(markerIndex)) return { outcome: 'replay' };
      // UPDATE# or SEEN# exists: this content was accepted before.
      if (failed(0) || failed(1)) return { outcome: 'duplicate' };
      // Only the METADATA condition failed: a newer message was applied meanwhile.
      if (!historyOnly && failed(3)) return 'raced';
    }
    throw error;
  }
}

/** The dispatch a CAD identity's idempotency lock points at, if the lock is still live. */
export async function lockedDispatchId(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  externalDispatchId: string,
  nowSeconds: number,
): Promise<string | undefined> {
  const { Item } = await client.send(
    new GetCommand({
      TableName: tableName,
      Key: {
        pk: buildDeptScopedPk(deptId, 'DISPATCH_IDEMPOTENCY', 'CAD', externalDispatchId),
        sk: 'LOCK',
      },
      ConsistentRead: true,
    }),
  );
  if (!Item || typeof Item.dispatchId !== 'string') return undefined;
  if (typeof Item.expiresAt === 'number' && Item.expiresAt <= nowSeconds) return undefined;
  return Item.dispatchId;
}

/**
 * Whether a recorded update still owes its UPDATE push (no notifiedAt). A duplicate or replay
 * of an update checks this and re-invokes the notifier, so a hand-off lost when the ingress
 * Lambda died after commit is recovered by the sender's retry.
 */
export async function updateNeedsNotice(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
  updateId: string,
): Promise<boolean> {
  const { Item } = await client.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: buildDeptScopedPk(deptId, 'DISPATCH', dispatchId), sk: `UPDATE#${updateId}` },
      ConsistentRead: true,
    }),
  );
  return Item?.entityType === 'DISPATCH_UPDATE' && Item.applied !== false && !Item.notifiedAt;
}
