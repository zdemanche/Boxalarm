import { PublishCommand, type SNSClient } from '@aws-sdk/client-sns';
import {
  PutCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { randomUUID } from 'node:crypto';
import { queryEligibleMembers, type EligibilitySnapshotItem } from '../eligibility/selector.js';
import { resolvePushTarget } from '../eligibility/resolvePushTarget.js';
import { logError, logInfo } from '../dispatches/logger.js';

export type MutualAidReason = 'TONE_3_PREDICATE_UNMET' | 'MANUAL';

export interface MutualAidRequestInput {
  readonly ddb: DynamoDBDocumentClient;
  readonly sns: SNSClient;
  readonly tableName: string;
  readonly topicArn: string;
  readonly deptId: VerifiedDeptId;
  readonly dispatchId: string;
  readonly reason: MutualAidReason;
}

export interface MutualAidResult {
  readonly requested: boolean;
  readonly officersNotified: number;
  readonly adapterUsed: string;
}

export interface MutualAidPort {
  requestMutualAid(input: MutualAidRequestInput): Promise<MutualAidResult>;
}

const ADAPTER_NAME = 'OFFICER_MANUAL_PROMPT';
const OFFICER_ROLE = 'OFFICER';

async function promptOfficer(
  ddb: DynamoDBDocumentClient,
  sns: SNSClient,
  tableName: string,
  topicArn: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
  officer: EligibilitySnapshotItem,
): Promise<boolean> {
  const pushTarget = resolvePushTarget(officer.contactChannels);
  const idempotencyKey = `${dispatchId}#MUTUALAID#${officer.memberId}#push`;
  const item = {
    pk: buildDeptScopedPk(deptId, 'DISPATCH', dispatchId),
    sk: `MAPROMPT#${officer.memberId}#PUSH`,
    entityType: 'MUTUAL_AID_PROMPT',
    dispatchId,
    memberId: officer.memberId,
    deptId,
    idempotencyKey,
    sentAt: Math.floor(Date.now() / 1000),
    delivered: !pushTarget.skipped,
  };
  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
        ConditionExpression: 'attribute_not_exists(idempotencyKey)',
      }),
    );
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      return false;
    }
    logError('alerting.mutualAid.promptWriteFailed', error, {
      deptId,
      dispatchId,
      memberId: officer.memberId,
    });
    return false;
  }
  if (pushTarget.skipped) {
    return false;
  }
  try {
    await sns.send(
      new PublishCommand({
        TopicArn: topicArn,
        Message: JSON.stringify({
          eventId: randomUUID(),
          eventTime: new Date().toISOString(),
          eventType: 'alerting.mutual_aid.triggered',
          source: 'alerting-service',
          correlationId: dispatchId,
          schemaVersion: '1.0',
          payload: { dispatchId, memberId: officer.memberId, channel: 'push', mutualAid: true },
        }),
        MessageGroupId: dispatchId,
        MessageDeduplicationId: idempotencyKey,
        MessageAttributes: { channel: { DataType: 'String', StringValue: 'push' } },
      }),
    );
    return true;
  } catch (error) {
    logError('alerting.mutualAid.promptPublishFailed', error, {
      deptId,
      dispatchId,
      memberId: officer.memberId,
    });
    return false;
  }
}

export const officerManualPromptAdapter: MutualAidPort = {
  async requestMutualAid(input: MutualAidRequestInput): Promise<MutualAidResult> {
    const { ddb, sns, tableName, topicArn, deptId, dispatchId, reason } = input;
    const pk = buildDeptScopedPk(deptId, 'DISPATCH', dispatchId);

    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: tableName,
                Item: {
                  pk,
                  sk: 'MUTUALAID#SINGLETON',
                  entityType: 'MUTUAL_AID_EVENT',
                  dispatchId,
                  deptId,
                  reason,
                  adapterUsed: ADAPTER_NAME,
                  triggeredAt: Math.floor(Date.now() / 1000),
                },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'TransactionCanceledException') {
        logInfo('alerting.mutualAid.alreadyRequested', { deptId, dispatchId });
        return { requested: false, officersNotified: 0, adapterUsed: ADAPTER_NAME };
      }
      logError('alerting.mutualAid.eventWriteFailed', error, { deptId, dispatchId });
      throw error;
    }

    const eligibleMembers = await queryEligibleMembers(ddb, tableName, deptId);
    const officers = eligibleMembers.filter((member) => member.roles.includes(OFFICER_ROLE));

    let officersNotified = 0;
    for (const officer of officers) {
      const notified = await promptOfficer(
        ddb,
        sns,
        tableName,
        topicArn,
        deptId,
        dispatchId,
        officer,
      );
      if (notified) {
        officersNotified += 1;
      }
    }

    logInfo('alerting.mutualAid.requested', { deptId, dispatchId, reason, officersNotified });
    return { requested: true, officersNotified, adapterUsed: ADAPTER_NAME };
  },
};
