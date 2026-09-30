import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

/**
 * Replay cache on the alerting table: `DEPT#{deptId}#CAD_REPLAY#{sourceId}#{token}` with a TTL
 * (cad-ingress-auth: webhook 900 s, email 24 h).
 *
 * The marker is written as a conditional item INSIDE the dispatch transaction
 * (createManualDispatch / recordCadUpdate), so marker and dispatch commit together or not at
 * all (chain review M3): a failed or killed write leaves no marker, and the sender's identical
 * retry is processed, never refused as a replay of a dispatch that was never written.
 * `isReplayMarked` is only an early, read-only answer before parsing; the transaction's
 * condition is what decides.
 */

export interface ReplayRef {
  readonly deptId: VerifiedDeptId;
  readonly sourceId: string;
  readonly token: string;
}

function replayKey(ref: ReplayRef) {
  return { pk: buildDeptScopedPk(ref.deptId, 'CAD_REPLAY', ref.sourceId, ref.token), sk: 'REPLAY' };
}

export function replayMarkerItem(
  ref: ReplayRef,
  nowSeconds: number,
  ttlSeconds: number,
): Record<string, unknown> & { readonly pk: string; readonly sk: string } {
  return {
    ...replayKey(ref),
    entityType: 'CAD_REPLAY_MARKER',
    deptId: ref.deptId,
    createdAt: nowSeconds,
    ttl: nowSeconds + ttlSeconds,
  };
}

export async function isReplayMarked(
  client: DynamoDBDocumentClient,
  tableName: string,
  ref: ReplayRef,
  nowSeconds: number,
): Promise<boolean> {
  const { Item } = await client.send(
    new GetCommand({ TableName: tableName, Key: replayKey(ref), ConsistentRead: true }),
  );
  // DynamoDB TTL deletion lags; an expired marker is no marker.
  return Item !== undefined && typeof Item.ttl === 'number' && Item.ttl > nowSeconds;
}
