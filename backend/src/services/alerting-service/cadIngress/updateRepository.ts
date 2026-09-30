import { createHash } from 'node:crypto';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
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

export type RecordUpdateResult =
  | { readonly outcome: 'recorded'; readonly updateId: string; readonly changes: CadFieldChange[] }
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

export async function recordCadUpdate(
  client: DynamoDBDocumentClient,
  tableName: string,
  input: RecordUpdateInput,
): Promise<RecordUpdateResult> {
  const pk = buildDeptScopedPk(input.deptId, 'DISPATCH', input.dispatchId);
  const { Item: current } = await client.send(
    new GetCommand({ TableName: tableName, Key: { pk, sk: 'METADATA' }, ConsistentRead: true }),
  );
  if (!current) return { outcome: 'missing' };
  if (current.cadContentHash === input.contentHash) return { outcome: 'duplicate' };

  const changes = diffDispatch(current, input.dispatch, input.parseStatus);
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

  const command = new TransactWriteCommand({
    TransactItems: [
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
            summary: summarizeChanges(changes),
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
      {
        Update: {
          TableName: tableName,
          Key: { pk, sk: 'METADATA' },
          UpdateExpression: `SET ${set.join(', ')}`,
          ConditionExpression:
            'attribute_exists(pk) AND (attribute_not_exists(cadContentHash) OR cadContentHash <> :hash)',
          ExpressionAttributeValues: values,
        },
      },
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
    ],
  });
  try {
    await client.send(command);
    return { outcome: 'recorded', updateId, changes };
  } catch (error) {
    if (error instanceof TransactionCanceledException) {
      const reasons = error.CancellationReasons ?? [];
      if (input.replayMarker && reasons[2]?.Code === 'ConditionalCheckFailed') {
        return { outcome: 'replay' };
      }
      if (reasons.some((reason) => reason.Code === 'ConditionalCheckFailed')) {
        return { outcome: 'duplicate' };
      }
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
