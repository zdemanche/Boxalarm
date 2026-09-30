import { createHash } from 'node:crypto';
import { PublishCommand, type SNSClient } from '@aws-sdk/client-sns';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { buildCadUpdatePayload, readDispatchAlertText } from '../channels/channelEnvelope.js';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
import { buildAlertingEnvelope } from '../escalation/alertingEnvelope.js';
import { createSnsClient, readFanOutTopicConfig } from '../fanout/snsClient.js';
import { logError, logInfo } from '../dispatches/logger.js';
import { emitCadMetric } from './metrics.js';

/**
 * The UPDATE push for a CAD update (docs/decisions/2026-09-30-cad-dispatch-updates.md).
 * Invoked ASYNCHRONOUSLY by the ingress Lambda once the DISPATCH_UPDATE is durably written
 * (notifyUpdate below) - not from the table stream, which already has its two readers (fan-out,
 * outbox drain); a third would throttle the tone-1 fan-out. Lambda's async retries and the
 * alarmed on-failure queue cover a failed run.
 *  - audience: members already on that dispatch's roster (ROSTER#{memberId}), nobody new;
 *  - push only, non-escalating: no SMS, no voice, no tone ladder, no receipt under RECEIPT#;
 *  - exactly once per update per member: a CADUPDATE#{updateId}#{memberId}#PUSH claim before
 *    publish (sentAt after), the hashed MessageDeduplicationId inside SNS FIFO's window, and
 *    the push worker's own CADUPDATE#...#SEND guard after it.
 * The event names the update only; everything else is read back from the table.
 */

interface UpdateRecord {
  readonly deptId: VerifiedDeptId;
  readonly dispatchId: string;
  readonly updateId: string;
  readonly summary: string;
}

export interface CadUpdateNotice {
  readonly deptId: string;
  readonly dispatchId: string;
  readonly updateId: string;
}

async function readUpdate(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  notice: CadUpdateNotice,
): Promise<UpdateRecord | undefined> {
  if (
    typeof notice?.deptId !== 'string' ||
    typeof notice.dispatchId !== 'string' ||
    typeof notice.updateId !== 'string' ||
    !/^[0-9a-f]{16,64}$/.test(notice.updateId)
  ) {
    throw new Error('CAD update notice failed shape validation');
  }
  const deptId = toVerifiedDeptId({ deptId: notice.deptId });
  const { Item } = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: {
        pk: buildDeptScopedPk(deptId, 'DISPATCH', notice.dispatchId),
        sk: `UPDATE#${notice.updateId}`,
      },
      ConsistentRead: true,
    }),
  );
  if (Item?.entityType !== 'DISPATCH_UPDATE') return undefined;
  return {
    deptId,
    dispatchId: notice.dispatchId,
    updateId: notice.updateId,
    summary: typeof Item.summary === 'string' ? Item.summary : 'Dispatch updated',
  };
}

async function rosterMemberIds(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
): Promise<string[]> {
  const members: string[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :roster)',
        ExpressionAttributeValues: {
          ':pk': buildDeptScopedPk(deptId, 'DISPATCH', dispatchId),
          ':roster': 'ROSTER#',
        },
        ProjectionExpression: 'sk',
        ConsistentRead: true,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    for (const item of page.Items ?? []) {
      const sk = String(item.sk);
      members.push(sk.slice('ROSTER#'.length));
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return members;
}

async function notifyMember(
  ddb: DynamoDBDocumentClient,
  sns: SNSClient,
  tableName: string,
  topicArn: string,
  update: UpdateRecord,
  dispatch: ReturnType<typeof readDispatchAlertText>,
  memberId: string,
): Promise<'SENT' | 'ALREADY_SENT'> {
  const pk = buildDeptScopedPk(update.deptId, 'DISPATCH', update.dispatchId);
  const key = { pk, sk: `CADUPDATE#${update.updateId}#${memberId}#PUSH` };
  const idempotencyKey = `${update.dispatchId}#CADUPDATE#${update.updateId}#${memberId}#push`;
  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          ...key,
          entityType: 'CAD_UPDATE_NOTICE',
          deptId: update.deptId,
          dispatchId: update.dispatchId,
          updateId: update.updateId,
          memberId,
          idempotencyKey,
          claimedAt: Math.floor(Date.now() / 1000),
        },
        ConditionExpression: 'attribute_not_exists(idempotencyKey)',
      }),
    );
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'ConditionalCheckFailedException') throw error;
    const existing = await ddb.send(
      new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }),
    );
    if (existing.Item?.sentAt) return 'ALREADY_SENT';
  }
  await sns.send(
    new PublishCommand({
      TopicArn: topicArn,
      Message: JSON.stringify(
        buildAlertingEnvelope(
          'alerting.dispatch.updated',
          update.dispatchId,
          buildCadUpdatePayload({
            deptId: update.deptId,
            dispatchId: update.dispatchId,
            memberId,
            updateId: update.updateId,
            summary: update.summary,
            dispatch,
          }),
        ),
      ),
      MessageGroupId: update.dispatchId,
      MessageDeduplicationId: createHash('sha256').update(idempotencyKey).digest('hex'),
      MessageAttributes: { channel: { DataType: 'String', StringValue: 'push' } },
    }),
  );
  await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: key,
      UpdateExpression: 'SET sentAt = :sentAt',
      ExpressionAttributeValues: { ':sentAt': Math.floor(Date.now() / 1000) },
    }),
  );
  return 'SENT';
}

async function processUpdate(
  ddb: DynamoDBDocumentClient,
  sns: SNSClient,
  tableName: string,
  topicArn: string,
  update: UpdateRecord,
): Promise<void> {
  const pk = buildDeptScopedPk(update.deptId, 'DISPATCH', update.dispatchId);
  const { Item } = await ddb.send(
    new GetCommand({ TableName: tableName, Key: { pk, sk: 'METADATA' }, ConsistentRead: true }),
  );
  if (!Item || Item.isTest === true) return;
  const dispatch = readDispatchAlertText(Item);
  const members = await rosterMemberIds(ddb, tableName, update.deptId, update.dispatchId);
  const results = await Promise.allSettled(
    members.map((memberId) =>
      notifyMember(ddb, sns, tableName, topicArn, update, dispatch, memberId),
    ),
  );
  const failed = results.filter((r) => r.status === 'rejected');
  logInfo('cadIngress.update.notified', {
    deptId: update.deptId,
    dispatchId: update.dispatchId,
    updateId: update.updateId,
    members: members.length,
    failed: failed.length,
  });
  emitCadMetric('CadUpdatePushPublished', {});
  if (failed.length > 0) {
    for (const failure of failed) {
      logError('cadIngress.update.notifyFailed', failure.reason, {
        dispatchId: update.dispatchId,
        updateId: update.updateId,
      });
    }
    emitCadMetric('CadUpdatePushFailed', {});
    // Retry the record: sent members are skipped (sentAt), unsent ones go out again.
    throw new Error(`update push failed for ${failed.length} of ${members.length} members`);
  }
}

export const handler = async (notice: CadUpdateNotice): Promise<void> => {
  const { tableName } = readAlertingConfig(process.env);
  const ddb = createDynamoClient(process.env);
  const sns = createSnsClient(process.env);
  const { topicArn } = readFanOutTopicConfig(process.env);
  const update = await readUpdate(ddb, tableName, notice);
  if (!update) {
    logError('cadIngress.update.missing', new Error('no DISPATCH_UPDATE for the notice'), {
      dispatchId: notice.dispatchId,
      updateId: notice.updateId,
    });
    return;
  }
  // Throws on a failure: Lambda retries the async event, then the alarmed on-failure queue.
  await processUpdate(ddb, sns, tableName, topicArn, update);
};
