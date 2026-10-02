import { DeleteCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { sendEmailDigest, sendPushDigest } from '../channelSender.js';
import { categoryConfig, type ReminderItem } from '../reminders/categories.js';
import { loadRoster, membersWithRoles, readChannelMutes } from '../reminders/recipients.js';
import { buildNotificationItem, isConditionalPutFailed } from '../repository.js';
import { logError, METRIC_NAMESPACE, type EventEnvelope } from './reminderIngest.js';

/**
 * Immediate (non-digest) delivery of one event to every member holding the category's roles:
 * an idempotent inbox record (conditional Put keyed on eventId and event time), then one
 * claim-guarded send per channel, honouring the member's NOTIFPREF mutes before any publish.
 * Extracted from the out-of-service defect path so apparatus.serviceStatus.changed (owed
 * review minor 10) delivers through exactly the same pipeline.
 */

export type ImmediateOutcome = 'Delivered' | 'Failed';
export type ChannelOutcome = 'Sent' | 'AlreadySent' | 'Muted' | 'Failed';

export interface ImmediateDeliverySpec {
  /** The reminder category: its roles pick the recipients, its muteKey the preference row. */
  readonly category: string;
  /** Per-channel claim markers ({marker}#{eventId} on the member partition). */
  readonly pushMarker: string;
  readonly emailMarker: string;
  /** Metric name prefix, e.g. 'ApparatusDefect' -> ApparatusDefectPushSent. */
  readonly metricPrefix: string;
  /** Structured-log event prefix, e.g. 'notification.apparatusDefect'. */
  readonly logPrefix: string;
  /** What an empty recipient set means, for the log line (infrastructure alarms on the metric). */
  readonly noRecipientsError: string;
}

/**
 * How long a channel claim stays owned by the invocation that took it. The queue's
 * visibility timeout (30s) outlasts the Lambda's (25s), so by the time SQS redelivers a
 * message whose handler died between claiming and sending, the claim is stale and the
 * redelivery takes it over rather than skipping the send.
 */
export const CLAIM_STALE_MS = 30_000;
const CLAIM_TTL_SECONDS = 7 * 24 * 60 * 60;

function claimKey(deptId: VerifiedDeptId, memberId: string, marker: string, eventId: string) {
  return { pk: buildDeptScopedPk(deptId, 'MEMBER', memberId), sk: `${marker}#${eventId}` };
}

/**
 * At-most-once-per-success delivery on one channel, independent of the inbox record: claim
 * `{marker}#{eventId}` (new, or abandoned by a dead invocation), send, then stamp sentAt.
 * A failed send releases only the claim, so the redelivery retries just that channel.
 */
export async function sendOnce(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  memberId: string,
  marker: string,
  envelope: EventEnvelope,
  logPrefix: string,
  send: () => Promise<void>,
): Promise<ChannelOutcome> {
  const key = claimKey(deptId, memberId, marker, envelope.eventId);
  const now = Date.now();
  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          ...key,
          entityType: 'NOTIFICATION_DELIVERY_CLAIM',
          claimedAt: now,
          ttl: Math.floor(now / 1000) + CLAIM_TTL_SECONDS,
        },
        ConditionExpression:
          'attribute_not_exists(sk) OR (attribute_not_exists(sentAt) AND claimedAt < :staleBefore)',
        ExpressionAttributeValues: { ':staleBefore': now - CLAIM_STALE_MS },
      }),
    );
  } catch (error) {
    if (isConditionalPutFailed(error)) {
      return 'AlreadySent';
    }
    logError(`${logPrefix}.claim_failed`, error, envelope.eventId, { memberId, marker });
    return 'Failed';
  }

  try {
    await send();
  } catch (error) {
    logError(`${logPrefix}.send_failed`, error, envelope.eventId, { memberId, marker });
    try {
      await ddb.send(new DeleteCommand({ TableName: tableName, Key: key }));
    } catch (releaseError) {
      logError(`${logPrefix}.release_failed`, releaseError, envelope.eventId, {
        memberId,
        marker,
      });
    }
    return 'Failed';
  }

  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          ...key,
          entityType: 'NOTIFICATION_DELIVERY_CLAIM',
          claimedAt: now,
          sentAt: Date.now(),
          ttl: Math.floor(now / 1000) + CLAIM_TTL_SECONDS,
        },
      }),
    );
  } catch (error) {
    // Sent, but not recorded as sent: a redelivery after the claim goes stale may send again.
    logError(`${logPrefix}.mark_sent_failed`, error, envelope.eventId, { memberId, marker });
  }
  return 'Sent';
}

/**
 * One recipient's copy. The inbox record is written idempotently (a conditional Put keyed on
 * the eventId and event time; "already there" is success) and is never removed. Each outbound
 * channel then goes through its own claim, so a failure on one channel neither erases the
 * inbox record nor blocks a retry of the send.
 */
export async function deliverTo(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  memberId: string,
  email: string | undefined,
  item: ReminderItem,
  envelope: EventEnvelope,
  createdAt: number,
  spec: ImmediateDeliverySpec,
): Promise<ImmediateOutcome> {
  const notification = buildNotificationItem(
    deptId,
    memberId,
    envelope.eventId,
    spec.category,
    [item],
    createdAt,
  );
  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: notification,
        ConditionExpression: 'attribute_not_exists(sk)',
      }),
    );
  } catch (error) {
    if (!isConditionalPutFailed(error)) {
      logError(`${spec.logPrefix}.inbox_write_failed`, error, envelope.eventId, { memberId });
      return 'Failed';
    }
  }

  let mutes: { push: boolean; email: boolean };
  try {
    mutes = await readChannelMutes(
      ddb,
      tableName,
      deptId,
      memberId,
      categoryConfig(spec.category).muteKey,
    );
  } catch (error) {
    logError(`${spec.logPrefix}.mute_read_failed`, error, envelope.eventId, { memberId });
    return 'Failed';
  }

  const push: ChannelOutcome = mutes.push
    ? 'Muted'
    : await sendOnce(ddb, tableName, deptId, memberId, spec.pushMarker, envelope, spec.logPrefix, () =>
        sendPushDigest(
          process.env,
          { memberId, deptId, email },
          [item],
          envelope.correlationId ?? envelope.eventId,
          undefined,
          spec.category,
        ),
      );
  emitOutcomeMetric(METRIC_NAMESPACE, `${spec.metricPrefix}Push${push}`);

  // Email runs alongside push (the push worker delivers the topic's messages), so an officer
  // away from the app still hears now — it must not wait for tomorrow's digest.
  const emailed: ChannelOutcome = mutes.email
    ? 'Muted'
    : await sendOnce(ddb, tableName, deptId, memberId, spec.emailMarker, envelope, spec.logPrefix, () =>
        sendEmailDigest(
          process.env,
          { memberId, deptId, email },
          [item],
          envelope.correlationId ?? envelope.eventId,
          undefined,
          spec.category,
        ),
      );
  emitOutcomeMetric(METRIC_NAMESPACE, `${spec.metricPrefix}Email${emailed}`);
  return push === 'Failed' || emailed === 'Failed' ? 'Failed' : 'Delivered';
}

export async function deliverImmediately(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  item: ReminderItem,
  envelope: EventEnvelope,
  spec: ImmediateDeliverySpec,
): Promise<void> {
  const roster = await loadRoster(ddb, tableName, deptId);
  const recipients = membersWithRoles(roster, categoryConfig(spec.category).roles);
  // Validated by the consumer before it gets here: the inbox record's key is built from the
  // event time, so it must be the same on every redelivery — never the clock.
  const createdAt = Date.parse(envelope.eventTime!);

  let failed = 0;
  for (const member of recipients) {
    const outcome = await deliverTo(
      ddb,
      tableName,
      deptId,
      member.memberId,
      member.email,
      item,
      envelope,
      createdAt,
      spec,
    );
    emitOutcomeMetric(METRIC_NAMESPACE, `${spec.metricPrefix}Immediate${outcome}`);
    if (outcome === 'Failed') {
      failed += 1;
    }
  }
  if (recipients.length === 0) {
    // A change nobody is told about: infrastructure alarms on this metric and notifies the
    // chief (notification/reminders.ts).
    logError(`${spec.logPrefix}.no_recipients`, new Error(spec.noRecipientsError), envelope.eventId, {
      subjectId: item.subjectId,
    });
    emitOutcomeMetric(METRIC_NAMESPACE, `${spec.metricPrefix}ImmediateNoRecipients`);
  }
  if (failed > 0) {
    // Everyone already delivered is a conditional no-op on the redelivery.
    throw new Error(`immediate delivery failed for ${failed} recipient(s)`);
  }
}
