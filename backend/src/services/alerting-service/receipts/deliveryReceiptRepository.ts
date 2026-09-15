import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { QueryCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

// Lowercase, matching the fan-out producer's FanOutChannel type (fanout/idempotencyKey.ts)
// and the routing/dedup canonical form in CLAUDE.md ("channel (push/sms/voice)"). This must
// stay byte-identical to what E1-S2's fan-out writes into the sk, or every webhook update
// silently 404s against a receipt that does exist under a differently-cased key.
export type DeliveryChannel = 'push' | 'sms' | 'voice';

export interface UpdateDeliveryReceiptInput {
  readonly deptId: VerifiedDeptId;
  readonly dispatchId: string;
  readonly memberId: string;
  readonly channel: DeliveryChannel;
  readonly toneSequence: number;
  readonly deliveredAt?: number;
  readonly openedAt?: number;
  readonly failureReason?: string;
}

export type UpdateDeliveryReceiptResult =
  { readonly outcome: 'updated' } | { readonly outcome: 'not_found' };

export function deriveDeptIdFromDispatchId(dispatchId: string): string {
  return dispatchId.split('-')[0] ?? '';
}

export function buildReceiptKey(
  deptId: VerifiedDeptId,
  dispatchId: string,
  memberId: string,
  channel: DeliveryChannel,
  toneSequence: number,
): { pk: string; sk: string } {
  return {
    pk: buildDeptScopedPk(deptId, 'DISPATCH', dispatchId),
    sk: `RECEIPT#${memberId}#${channel}#${toneSequence}`,
  };
}

export async function updateDeliveryReceipt(
  client: DynamoDBDocumentClient,
  tableName: string,
  input: UpdateDeliveryReceiptInput,
): Promise<UpdateDeliveryReceiptResult> {
  const key = buildReceiptKey(
    input.deptId,
    input.dispatchId,
    input.memberId,
    input.channel,
    input.toneSequence,
  );

  const setClauses: string[] = [];
  const values: Record<string, unknown> = {};
  if (input.deliveredAt !== undefined) {
    setClauses.push('deliveredAt = if_not_exists(deliveredAt, :deliveredAt)');
    values[':deliveredAt'] = input.deliveredAt;
  }
  if (input.openedAt !== undefined) {
    setClauses.push('openedAt = if_not_exists(openedAt, :openedAt)');
    values[':openedAt'] = input.openedAt;
  }
  if (input.failureReason !== undefined) {
    setClauses.push('failureReason = if_not_exists(failureReason, :failureReason)');
    values[':failureReason'] = input.failureReason;
  }
  if (setClauses.length === 0) {
    return { outcome: 'updated' };
  }

  try {
    await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: key,
        UpdateExpression: `SET ${setClauses.join(', ')}`,
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: values,
      }),
    );
    return { outcome: 'updated' };
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return { outcome: 'not_found' };
    }
    throw error;
  }
}

export interface DeliveryReceiptRecord {
  readonly memberId: string;
  readonly channel: string;
  readonly toneSequence: number;
  readonly sentAt: number;
  readonly deliveredAt?: number;
  readonly openedAt?: number;
  readonly failureReason?: string;
}

export async function queryReceiptsForDispatch(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
): Promise<DeliveryReceiptRecord[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: {
          ':pk': buildDeptScopedPk(deptId, 'DISPATCH', dispatchId),
          ':prefix': 'RECEIPT#',
        },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(...(result.Items ?? []));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey !== undefined);

  return items.map((item) => ({
    memberId: item.memberId as string,
    channel: item.channel as string,
    toneSequence: item.toneSequence as number,
    sentAt: item.sentAt as number,
    ...(item.deliveredAt !== undefined ? { deliveredAt: item.deliveredAt as number } : {}),
    ...(item.openedAt !== undefined ? { openedAt: item.openedAt as number } : {}),
    ...(item.failureReason !== undefined ? { failureReason: item.failureReason as string } : {}),
  }));
}
