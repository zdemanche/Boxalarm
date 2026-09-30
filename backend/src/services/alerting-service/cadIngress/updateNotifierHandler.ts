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
 *  - audience: the members tone 1 paged (tone-1 RECEIPT#), once tone-1 fan-out has completed
 *    (fanOutCompletedAt) - until then it throws and the async retry comes back later;
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

/**
 * Members the tone-1 fan-out actually paged: the distinct members holding a tone-1 RECEIPT#
 * (`RECEIPT#{memberId}#{channel}#1`). ROSTER# rows are seeded only after the pages go out, so
 * they were an incomplete audience while fan-out ran (chain review R2-M2).
 */
async function toneOneMemberIds(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
): Promise<string[]> {
  const members = new Set<string>();
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :receipt)',
        ExpressionAttributeValues: {
          ':pk': buildDeptScopedPk(deptId, 'DISPATCH', dispatchId),
          ':receipt': 'RECEIPT#',
        },
        ProjectionExpression: 'sk',
        ConsistentRead: true,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    for (const item of page.Items ?? []) {
      const [, memberId, , tone] = String(item.sk).split('#');
      if (memberId && tone === '1') members.add(memberId);
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return [...members];
}

/** Thrown while tone-1 fan-out is still running: the async invoke retries later (bounded). */
export class FanOutNotCompleteError extends Error {
  constructor(dispatchId: string) {
    super(`tone-1 fan-out of ${dispatchId} has not completed; retrying the update push later`);
    this.name = 'FanOutNotCompleteError';
  }
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
  // Wait for tone 1 to finish: until then the audience is incomplete, and members paged after
  // the update already got its content in their tone-1 page (fan-out reads the current record).
  if (typeof Item.fanOutCompletedAt !== 'number') {
    emitCadMetric('CadUpdateWaitingForFanOut', {});
    throw new FanOutNotCompleteError(update.dispatchId);
  }
  const dispatch = readDispatchAlertText(Item);
  const members = await toneOneMemberIds(ddb, tableName, update.deptId, update.dispatchId);
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
