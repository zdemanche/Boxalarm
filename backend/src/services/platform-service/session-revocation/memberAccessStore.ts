import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { randomUUID } from 'node:crypto';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { captureAWSv3Client } from 'aws-xray-sdk-core';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';

export function readPlatformTableName(env: NodeJS.ProcessEnv): string {
  const tableName = env.PLATFORM_TABLE_NAME;
  if (!tableName) {
    throw new Error('PLATFORM_TABLE_NAME is required and was not set');
  }
  return tableName;
}

let cachedDocClient: DynamoDBDocumentClient | undefined;

export function getAccessStoreClient(override?: DynamoDBDocumentClient): DynamoDBDocumentClient {
  if (override) {
    return override;
  }
  cachedDocClient ??= DynamoDBDocumentClient.from(captureAWSv3Client(new DynamoDBClient({})));
  return cachedDocClient;
}

/**
 * The member row's current status, or undefined when there is no row. Session revocation
 * acts on this rather than on the status an event carries: the queue is standard SQS, so
 * LOA -> ACTIVE in quick succession can be delivered out of order. Reading the row is not
 * enough on its own (the row can change between the read and the Cognito call), so the
 * consumer re-reads after acting and reconciles - see convergeLoginState.
 */
export async function readMemberStatus(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  deptId: string,
  memberId: string,
): Promise<string | undefined> {
  const result = await docClient.send(
    new GetCommand({
      TableName: tableName,
      Key: {
        pk: buildDeptScopedPk(toVerifiedDeptId({ deptId }), 'MEMBER', memberId),
        sk: 'METADATA',
      },
      ProjectionExpression: '#status',
      ExpressionAttributeNames: { '#status': 'status' },
      ConsistentRead: true,
    }),
  );
  const status: unknown = result.Item?.status;
  return typeof status === 'string' ? status : undefined;
}

interface ContactChannelEntry {
  readonly channel: string;
  readonly [field: string]: unknown;
}

export type PushInvalidationResult = 'invalidated' | 'no-push-entry' | 'no-member';

/**
 * Device loss (review M2): stop the lost phone receiving dispatch pushes - incident type and
 * address on the lock screen - by removing the member's PUSH contact channel. This is the
 * same write personnel-service's DELETE .../push-tokens makes (pushTokens/revokeToken.ts),
 * reproduced rather than called because that route only lets a member revoke their own
 * token: the member row loses its PUSH entry and a personnel.member.updated outbox row
 * carries the new contactChannels to the alerting eligibility snapshot. `source` is
 * personnel-service because that is the only producer the alerting-plane rule accepts for
 * this event, and the event describes a change to the member record.
 *
 * There is one PUSH entry per member, so this also drops a replacement phone registered
 * before the loss was reported. That device re-registers when it next signs in, which the
 * global sign-out already requires; SMS/voice keep paging the member meanwhile.
 */
export async function invalidateMemberPush(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  deptId: string,
  memberId: string,
  correlationId: string,
): Promise<PushInvalidationResult> {
  const verifiedDeptId = toVerifiedDeptId({ deptId });
  const pk = buildDeptScopedPk(verifiedDeptId, 'MEMBER', memberId);
  const existing = await docClient.send(
    new GetCommand({ TableName: tableName, Key: { pk, sk: 'METADATA' }, ConsistentRead: true }),
  );
  if (!existing.Item) {
    return 'no-member';
  }
  const current = (existing.Item.contactChannels as ContactChannelEntry[] | undefined) ?? [];
  const contactChannels = current.filter((entry) => entry.channel !== 'PUSH');
  if (contactChannels.length === current.length) {
    return 'no-push-entry';
  }

  const now = Date.now();
  const eventId = randomUUID();
  await docClient.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: tableName,
            Key: { pk, sk: 'METADATA' },
            ConditionExpression: 'attribute_exists(pk)',
            UpdateExpression: 'SET contactChannels = :cc, updatedAt = :ts',
            ExpressionAttributeValues: { ':cc': contactChannels, ':ts': now },
          },
        },
        {
          Put: {
            TableName: tableName,
            Item: {
              pk: buildDeptScopedPk(verifiedDeptId, 'OUTBOX', memberId),
              sk: `EVT#${eventId}`,
              entityType: 'OUTBOX_ENTRY',
              eventId,
              eventTime: new Date(now).toISOString(),
              eventType: 'personnel.member.updated',
              source: 'personnel-service',
              correlationId,
              schemaVersion: '1.0',
              payload: { memberId, deptId, contactChannels },
              sentAt: null,
            },
          },
        },
      ],
    }),
  );
  return 'invalidated';
}
