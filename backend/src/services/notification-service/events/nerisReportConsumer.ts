import { PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import type { SQSEvent } from 'aws-lambda';
import { createDynamoClient, readNotificationConfig } from '../dynamoClient.js';
import { NERIS_REJECTED_CATEGORY, type ReminderItem } from '../reminders/categories.js';
import { loadRoster, membersWithRoles } from '../reminders/recipients.js';
import { buildNotificationItem, isConditionalPutFailed } from '../repository.js';
import {
  logError,
  MalformedEventError,
  METRIC_NAMESPACE,
  optionalString,
  parseEnvelope,
  recordReminder,
  requireString,
  type EventEnvelope,
} from './reminderIngest.js';

const REJECTED = 'neris.incident.rejected';
const FAILED = 'neris.incident.failed';
const SUBMISSION_FAILED = 'neris.submission.failed';
const MISSING = 'neris.incident.missing';
const LOG_PREFIX = 'notification.nerisReport';

/**
 * A report that NERIS sent back or that could not be sent at all:
 *   - neris.incident.rejected | neris.incident.failed (the status poller: NERIS's verdict);
 *   - neris.submission.failed (the submission worker: a 422 at send time, revoked
 *     credentials, the department not configured, or retries exhausted — review M6);
 *   - neris.incident.missing (the nightly reconciliation: NERIS stopped listing a record it
 *     had accepted, and it was given up on after bounded re-checks — round 2, N6).
 *
 * The report owner, the officer who locked it, and every active OFFICER get an inbox item
 * right away (not only the next daily digest: the NERIS target is 72 hours), each linking to
 * the report. The owner's copy and the officers' copy also go into the daily digest, which
 * carries the push and email.
 */

interface NerisReportReminder {
  readonly deptId: string;
  readonly ownerId: string;
  readonly lockedBy?: string;
  readonly item: ReminderItem;
}

export function toNerisReportReminder({ eventType, payload }: EventEnvelope): NerisReportReminder {
  const incidentId = requireString(payload, 'incidentId', eventType);
  const ownerId = requireString(payload, 'ownerId', eventType);
  const incidentNumber = optionalString(payload, 'incidentNumber') ?? incidentId;
  const lockedBy = optionalString(payload, 'lockedBy');
  const when = optionalString(payload, 'statusAt') ?? optionalString(payload, 'outcome') ?? '';
  const reason = optionalString(payload, 'failureReason') ?? optionalString(payload, 'reason');
  const detail =
    eventType === REJECTED
      ? 'was rejected by NERIS: fix it and resubmit'
      : eventType === FAILED
        ? "couldn't be processed by NERIS: check the submission and resubmit"
        : eventType === MISSING
          ? 'is no longer listed by NERIS: open the report and resubmit it, and Boxalarm will send it to NERIS again'
          : `didn't reach NERIS${reason ? ` (${reason.slice(0, 200)})` : ''}: fix it and retry`;
  return {
    deptId: requireString(payload, 'deptId', eventType),
    ownerId,
    ...(lockedBy && lockedBy !== ownerId ? { lockedBy } : {}),
    item: {
      subjectId: `${incidentId}:${eventType}:${when}`,
      title: `Report ${incidentNumber}`,
      detail,
      link: { kind: 'incident', id: incidentId },
    },
  };
}

async function writeInbox(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  memberId: string,
  item: ReminderItem,
  envelope: EventEnvelope,
  createdAt: number,
): Promise<'Delivered' | 'Duplicate' | 'Failed'> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: buildNotificationItem(
          deptId,
          memberId,
          envelope.eventId,
          NERIS_REJECTED_CATEGORY,
          [item],
          createdAt,
        ),
        // Keyed on the event: a redelivery writes nothing twice.
        ConditionExpression: 'attribute_not_exists(sk)',
      }),
    );
    return 'Delivered';
  } catch (error) {
    if (isConditionalPutFailed(error)) return 'Duplicate';
    logError(`${LOG_PREFIX}.inbox_write_failed`, error, envelope.eventId, { memberId });
    return 'Failed';
  }
}

export const handler = async (event: SQSEvent): Promise<void> => {
  const { tableName } = readNotificationConfig(process.env);
  const ddb = createDynamoClient(process.env);

  for (const record of event.Records) {
    let envelope: EventEnvelope;
    let reminder: NerisReportReminder;
    try {
      envelope = parseEnvelope(
        record.body,
        new Set([REJECTED, FAILED, SUBMISSION_FAILED, MISSING]),
        REJECTED,
      );
      reminder = toNerisReportReminder(envelope);
    } catch (error) {
      logError(`${LOG_PREFIX}.malformed_event`, error, record.messageId);
      throw error instanceof MalformedEventError ? error : new MalformedEventError(REJECTED);
    }
    const deptId = toVerifiedDeptId({ deptId: reminder.deptId });
    // Stable per event, so a redelivery reuses the same inbox keys.
    const createdAt = Date.parse(envelope.eventTime ?? '') || Date.now();

    await recordReminder(
      ddb,
      tableName,
      deptId,
      envelope.eventId,
      {
        deptId: reminder.deptId,
        category: NERIS_REJECTED_CATEGORY,
        memberId: reminder.ownerId,
        item: reminder.item,
      },
      Date.now(),
    );

    const officers = membersWithRoles(await loadRoster(ddb, tableName, deptId), ['OFFICER']).map(
      (member) => member.memberId,
    );
    const recipients = [
      ...new Set([
        reminder.ownerId,
        ...(reminder.lockedBy ? [reminder.lockedBy] : []),
        ...officers,
      ]),
    ];
    const outcomes = await Promise.all(
      recipients.map((memberId) =>
        writeInbox(ddb, tableName, deptId, memberId, reminder.item, envelope, createdAt),
      ),
    );
    emitOutcomeMetric(METRIC_NAMESPACE, 'NerisReportInboxDelivered');
    if (outcomes.includes('Failed')) {
      emitOutcomeMetric(METRIC_NAMESPACE, 'NerisReportInboxFailed');
      // Throw so SQS redelivers; delivered copies are conditional no-ops next time.
      throw new Error('one or more NERIS report inbox writes failed');
    }
  }
};
