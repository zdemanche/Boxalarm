import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

/**
 * Replay cache on the alerting table: `DEPT#{deptId}#CAD_REPLAY#{sourceId}#{token}` with
 * `attribute_not_exists(pk)` and a TTL (cad-ingress-auth: the webhook's signature hex, TTL
 * 900 s; the email's Message-ID + DKIM b= hash, TTL 24 h). A failed conditional put is a
 * replay and never pages.
 *
 * The marker is released when the dispatch write after it fails, so the sender's retry of a
 * genuine dispatch is not refused as a replay; idempotency still stops a double page.
 */

function replayKey(deptId: VerifiedDeptId, sourceId: string, token: string) {
  return { pk: buildDeptScopedPk(deptId, 'CAD_REPLAY', sourceId, token), sk: 'REPLAY' };
}

export async function claimReplayToken(
  client: DynamoDBDocumentClient,
  tableName: string,
  input: {
    readonly deptId: VerifiedDeptId;
    readonly sourceId: string;
    readonly token: string;
    readonly nowSeconds: number;
    readonly ttlSeconds: number;
  },
): Promise<'claimed' | 'replay'> {
  try {
    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          ...replayKey(input.deptId, input.sourceId, input.token),
          entityType: 'CAD_REPLAY_MARKER',
          deptId: input.deptId,
          createdAt: input.nowSeconds,
          ttl: input.nowSeconds + input.ttlSeconds,
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
    return 'claimed';
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return 'replay';
    throw error;
  }
}

export async function releaseReplayToken(
  client: DynamoDBDocumentClient,
  tableName: string,
  input: { readonly deptId: VerifiedDeptId; readonly sourceId: string; readonly token: string },
): Promise<void> {
  await client.send(
    new DeleteCommand({
      TableName: tableName,
      Key: replayKey(input.deptId, input.sourceId, input.token),
    }),
  );
}
