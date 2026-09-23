import { randomUUID } from 'node:crypto';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { sendEmailDigest, sendPushDigest } from '../channelSender.js';
import { createDynamoClient, readNotificationConfig } from '../dynamoClient.js';
import {
  asTransactionCancellation,
  buildDigestSentMarker,
  buildNotificationItem,
  CERT_EXPIRY_CATEGORY,
  isConditionalCheckFailed,
  parsePreferenceItem,
  TODAY_BUCKET,
  TRAINING_OFFICER_DIGEST_CATEGORY,
  TRAINING_OFFICER_ROLE,
  type DigestNotificationItem,
  type PendingRecipientType,
} from '../repository.js';

const METRIC_NAMESPACE = 'Boxalarm/NotificationDigest';

export interface DigestJobPayload {
  readonly deptId: string;
}

interface RawPendingItem {
  readonly recipientType: PendingRecipientType;
  readonly recipientId: string;
  readonly certId: string;
  readonly expiryDate: string;
}

interface RecipientGroup {
  readonly recipientType: PendingRecipientType;
  readonly recipientId: string;
  readonly items: DigestNotificationItem[];
}

interface RosterOfficer {
  readonly memberId: string;
  readonly email?: string | undefined;
}

function isDigestJobPayload(value: unknown): value is DigestJobPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).deptId === 'string'
  );
}

function logError(
  event: string,
  error: unknown,
  correlationId: string,
  extra: Record<string, unknown> = {},
): void {
  console.error(
    JSON.stringify({
      event,
      service: 'notification-service',
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      message: error instanceof Error ? error.message : undefined,
      correlationId,
      ...extra,
    }),
  );
}

function groupByRecipient(items: readonly RawPendingItem[]): RecipientGroup[] {
  const groups = new Map<string, RecipientGroup>();
  for (const item of items) {
    const key = `${item.recipientType}#${item.recipientId}`;
    const entry: DigestNotificationItem = { certId: item.certId, expiryDate: item.expiryDate };
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(entry);
    } else {
      groups.set(key, {
        recipientType: item.recipientType,
        recipientId: item.recipientId,
        items: [entry],
      });
    }
  }
  return [...groups.values()];
}

async function queryPendingItems(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  today: string,
): Promise<RawPendingItem[]> {
  const items: RawPendingItem[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI3',
        KeyConditionExpression: 'gsi3pk = :gsi3pk',
        ExpressionAttributeValues: {
          ':gsi3pk': buildDeptScopedPk(deptId, 'DIGEST_PENDING', today),
        },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(...((result.Items ?? []) as RawPendingItem[]));
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return items;
}

async function resolveTrainingOfficers(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  correlationId: string,
): Promise<RosterOfficer[]> {
  const officers: RosterOfficer[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  try {
    do {
      const result = await ddb.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: 'GSI3',
          KeyConditionExpression: 'gsi3pk = :gsi3pk',
          ExpressionAttributeValues: { ':gsi3pk': buildDeptScopedPk(deptId, 'MEMBER') },
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      for (const item of result.Items ?? []) {
        const roles = (item.roles as string[] | undefined) ?? [];
        if (roles.includes(TRAINING_OFFICER_ROLE)) {
          officers.push({
            memberId: item.memberId as string,
            email: item.email as string | undefined,
          });
        }
      }
      exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (exclusiveStartKey);
  } catch (error) {
    logError('notification.digest.roster_query_failed', error, correlationId);
    throw error;
  }
  return officers;
}

async function claimDigestSlot(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  recipientId: string,
  category: string,
  today: string,
  now: number,
  correlationId: string,
): Promise<'Claimed' | 'AlreadyClaimed'> {
  const marker = buildDigestSentMarker(deptId, 'MEMBER', recipientId, category, today, now);
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: marker,
              ConditionExpression: 'attribute_not_exists(sk)',
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (isConditionalCheckFailed(error)) {
      return 'AlreadyClaimed';
    }
    const cancellation = asTransactionCancellation(error);
    logError('notification.digest.claim_failed', error, correlationId, {
      memberId: recipientId,
      ...(cancellation
        ? { cancellationReasons: cancellation.CancellationReasons?.map((r) => r.Code) }
        : {}),
    });
    emitOutcomeMetric(METRIC_NAMESPACE, 'DigestFailed');
    throw error;
  }
  return 'Claimed';
}

async function releaseDigestSlot(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  recipientId: string,
  category: string,
  today: string,
  correlationId: string,
): Promise<void> {
  const marker = buildDigestSentMarker(deptId, 'MEMBER', recipientId, category, today, 0);
  try {
    await ddb.send(
      new DeleteCommand({
        TableName: tableName,
        Key: { pk: buildDeptScopedPk(deptId, 'MEMBER', recipientId), sk: marker.sk },
      }),
    );
  } catch (error) {
    logError('notification.digest.release_failed', error, correlationId, {
      memberId: recipientId,
    });
  }
}

async function writeNotification(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  recipientId: string,
  category: string,
  items: readonly DigestNotificationItem[],
  now: number,
): Promise<void> {
  const notification = buildNotificationItem(
    deptId,
    recipientId,
    randomUUID(),
    category,
    items,
    now,
  );
  await ddb.send(new PutCommand({ TableName: tableName, Item: notification }));
}

async function sendDigestToMember(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  memberId: string,
  items: readonly DigestNotificationItem[],
  today: string,
  now: number,
  correlationId: string,
): Promise<void> {
  const claim = await claimDigestSlot(
    ddb,
    tableName,
    deptId,
    memberId,
    CERT_EXPIRY_CATEGORY,
    today,
    now,
    correlationId,
  );
  if (claim === 'AlreadyClaimed') {
    emitOutcomeMetric(METRIC_NAMESPACE, 'DigestSkipped');
    return;
  }

  const [member, preference] = await Promise.all([
    ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: buildDeptScopedPk(deptId, 'MEMBER', memberId), sk: 'METADATA' },
      }),
    ),
    ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          pk: buildDeptScopedPk(deptId, 'MEMBER', memberId),
          sk: `NOTIFPREF#${memberId}#${CERT_EXPIRY_CATEGORY}`,
        },
      }),
    ),
  ]);

  const email = member.Item?.email as string | undefined;
  const channels = parsePreferenceItem(preference.Item)?.channels;
  const pushMuted = channels?.push === true;
  const emailMuted = channels?.email === true;

  try {
    if (!pushMuted) {
      await sendPushDigest(process.env, { memberId, email }, items, correlationId);
    }
    if (!emailMuted) {
      await sendEmailDigest(process.env, { memberId, email }, items, correlationId);
    }
  } catch (error) {
    logError('notification.digest.send_failed', error, correlationId, {
      memberId,
      category: CERT_EXPIRY_CATEGORY,
    });
    emitOutcomeMetric(METRIC_NAMESPACE, 'DigestSendFailed');
    await releaseDigestSlot(
      ddb,
      tableName,
      deptId,
      memberId,
      CERT_EXPIRY_CATEGORY,
      today,
      correlationId,
    );
    throw error;
  }

  try {
    await writeNotification(ddb, tableName, deptId, memberId, CERT_EXPIRY_CATEGORY, items, now);
  } catch (error) {
    logError('notification.digest.write_failed', error, correlationId, { memberId });
    emitOutcomeMetric(METRIC_NAMESPACE, 'DigestFailed');
    await releaseDigestSlot(
      ddb,
      tableName,
      deptId,
      memberId,
      CERT_EXPIRY_CATEGORY,
      today,
      correlationId,
    );
    throw error;
  }

  emitOutcomeMetric(METRIC_NAMESPACE, pushMuted || emailMuted ? 'DigestMuted' : 'DigestSent');
}

async function sendDigestToTrainingOfficer(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  officer: RosterOfficer,
  items: readonly DigestNotificationItem[],
  today: string,
  now: number,
  correlationId: string,
): Promise<void> {
  const claim = await claimDigestSlot(
    ddb,
    tableName,
    deptId,
    officer.memberId,
    TRAINING_OFFICER_DIGEST_CATEGORY,
    today,
    now,
    correlationId,
  );
  if (claim === 'AlreadyClaimed') {
    emitOutcomeMetric(METRIC_NAMESPACE, 'DigestSkipped');
    return;
  }

  try {
    await sendPushDigest(process.env, officer, items, correlationId);
    await sendEmailDigest(process.env, officer, items, correlationId);
  } catch (error) {
    logError('notification.digest.send_failed', error, correlationId, {
      memberId: officer.memberId,
      category: TRAINING_OFFICER_DIGEST_CATEGORY,
    });
    emitOutcomeMetric(METRIC_NAMESPACE, 'DigestSendFailed');
    await releaseDigestSlot(
      ddb,
      tableName,
      deptId,
      officer.memberId,
      TRAINING_OFFICER_DIGEST_CATEGORY,
      today,
      correlationId,
    );
    throw error;
  }

  try {
    await writeNotification(
      ddb,
      tableName,
      deptId,
      officer.memberId,
      TRAINING_OFFICER_DIGEST_CATEGORY,
      items,
      now,
    );
  } catch (error) {
    logError('notification.digest.write_failed', error, correlationId, {
      memberId: officer.memberId,
    });
    emitOutcomeMetric(METRIC_NAMESPACE, 'DigestFailed');
    await releaseDigestSlot(
      ddb,
      tableName,
      deptId,
      officer.memberId,
      TRAINING_OFFICER_DIGEST_CATEGORY,
      today,
      correlationId,
    );
    throw error;
  }

  emitOutcomeMetric(METRIC_NAMESPACE, 'DigestSent');
}

export const handler = async (payload: unknown): Promise<{ processed: number }> => {
  if (!isDigestJobPayload(payload)) {
    const error = new Error('digest job payload failed shape validation');
    logError('notification.digest.malformed_payload', error, 'unknown');
    throw error;
  }

  const deptId = toVerifiedDeptId({ deptId: payload.deptId });
  const { tableName } = readNotificationConfig(process.env);
  const ddb = createDynamoClient(process.env);
  const now = Date.now();
  const today = TODAY_BUCKET(new Date(now));
  const correlationId = `${deptId}#${today}#digest`;

  let pendingItems: RawPendingItem[];
  try {
    pendingItems = await queryPendingItems(ddb, tableName, deptId, today);
  } catch (error) {
    logError('notification.digest.query_failed', error, correlationId);
    emitOutcomeMetric(METRIC_NAMESPACE, 'DigestFailed');
    throw error;
  }

  if (pendingItems.length === 0) {
    return { processed: 0 };
  }

  let processed = 0;
  for (const group of groupByRecipient(pendingItems)) {
    if (group.recipientType === 'MEMBER') {
      try {
        await sendDigestToMember(
          ddb,
          tableName,
          deptId,
          group.recipientId,
          group.items,
          today,
          now,
          correlationId,
        );
        processed += 1;
      } catch (error) {
        logError('notification.digest.recipient_failed', error, correlationId, {
          memberId: group.recipientId,
        });
        emitOutcomeMetric(METRIC_NAMESPACE, 'DigestRecipientFailed');
      }
      continue;
    }

    let officers: RosterOfficer[];
    try {
      officers = await resolveTrainingOfficers(ddb, tableName, deptId, correlationId);
    } catch (error) {
      logError('notification.digest.recipient_failed', error, correlationId, {
        recipientType: 'ROLE',
      });
      emitOutcomeMetric(METRIC_NAMESPACE, 'DigestRecipientFailed');
      continue;
    }
    for (const officer of officers) {
      try {
        await sendDigestToTrainingOfficer(
          ddb,
          tableName,
          deptId,
          officer,
          group.items,
          today,
          now,
          correlationId,
        );
        processed += 1;
      } catch (error) {
        logError('notification.digest.recipient_failed', error, correlationId, {
          memberId: officer.memberId,
        });
        emitOutcomeMetric(METRIC_NAMESPACE, 'DigestRecipientFailed');
      }
    }
  }

  return { processed };
};
