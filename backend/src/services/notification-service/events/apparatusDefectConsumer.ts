import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import type { SQSEvent } from 'aws-lambda';
import { createDynamoClient, readNotificationConfig } from '../dynamoClient.js';
import { APPARATUS_DEFECT_CATEGORY } from '../reminders/categories.js';
import { deliverImmediately, type ImmediateDeliverySpec } from './immediateDelivery.js';
import {
  logError,
  MalformedEventError,
  METRIC_NAMESPACE,
  parseEnvelope,
  recordReminder,
  requireString,
  type EventEnvelope,
  type ReminderRecord,
} from './reminderIngest.js';

export { CLAIM_STALE_MS } from './immediateDelivery.js';

const LABEL = 'apparatus.defect.reported';
const LOG_PREFIX = 'notification.apparatusDefect';

/** The shared immediate pipeline (inbox + mute-checked push and email), as the defect path. */
const DELIVERY_SPEC: ImmediateDeliverySpec = {
  category: APPARATUS_DEFECT_CATEGORY,
  pushMarker: 'DEFECTPUSH',
  emailMarker: 'DEFECTEMAIL',
  metricPrefix: 'ApparatusDefect',
  logPrefix: LOG_PREFIX,
  noRecipientsError: 'no active APPARATUS or OFFICER holder',
};

/** Severities that take a unit off the road: inbox + email now, as well as the digest. */
// apparatus-service's DefectSeverity is MINOR | MAJOR | OUT_OF_SERVICE (defectRepository.ts).
const IMMEDIATE_SEVERITIES: ReadonlySet<string> = new Set(['OUT_OF_SERVICE']);

interface DefectReminder extends ReminderRecord {
  readonly immediate: boolean;
}

function toDefectReminder({ payload, eventTime }: EventEnvelope): DefectReminder {
  // The inbox record for an out-of-service defect is keyed on the event time; the outbox
  // always sets it, and without it a redelivery could not find the record it already wrote.
  if (!eventTime || !Number.isFinite(Date.parse(eventTime))) {
    throw new MalformedEventError(LABEL);
  }
  const unitLabel = requireString(payload, 'unitLabel', LABEL);
  const severity = requireString(payload, 'severity', LABEL);
  const immediate = payload.outOfService === true || IMMEDIATE_SEVERITIES.has(severity);
  return {
    deptId: requireString(payload, 'deptId', LABEL),
    category: APPARATUS_DEFECT_CATEGORY,
    immediate,
    item: {
      subjectId: requireString(payload, 'defectId', LABEL),
      title: unitLabel,
      detail: immediate
        ? 'reported out of service'
        : `${severity.toLowerCase().replaceAll('_', ' ')} defect reported`,
      // The web apparatus detail route is keyed by the display unitId the event carries.
      link: { kind: 'apparatus', id: unitLabel },
    },
  };
}

/**
 * apparatus.defect.reported (apparatus-service outbox, F4.3) -> the APPARATUS role and
 * officers. Every defect is recorded for the daily digest (push + email + inbox). A defect
 * that takes the unit out of service (outOfService, or the OUT_OF_SERVICE severity)
 * is additionally written to their inboxes and emailed now, with a push on the
 * non-critical notification channel (delivered by the push worker) — never an
 * interruption-level alert. Recording it for the digest too means an out-of-service
 * defect reaches at least every channel a minor one does, even if the immediate email fails.
 */
export const handler = async (event: SQSEvent): Promise<void> => {
  const { tableName } = readNotificationConfig(process.env);
  const ddb = createDynamoClient(process.env);

  for (const record of event.Records) {
    let envelope: EventEnvelope;
    let reminder: DefectReminder;
    try {
      envelope = parseEnvelope(record.body, new Set([LABEL]), LABEL);
      reminder = toDefectReminder(envelope);
    } catch (error) {
      logError(`${LOG_PREFIX}.malformed_event`, error, record.messageId);
      throw error;
    }
    const deptId = toVerifiedDeptId({ deptId: reminder.deptId });

    try {
      const outcome = await recordReminder(
        ddb,
        tableName,
        deptId,
        envelope.eventId,
        reminder,
        Date.now(),
      );
      emitOutcomeMetric(
        METRIC_NAMESPACE,
        outcome === 'Duplicate'
          ? 'ApparatusDefectDuplicateSkipped'
          : 'ApparatusDefectPendingRecorded',
      );
    } catch (error) {
      logError(`${LOG_PREFIX}.write_failed`, error, envelope.eventId, {
        defectId: reminder.item.subjectId,
      });
      emitOutcomeMetric(METRIC_NAMESPACE, 'ApparatusDefectPendingFailed');
      throw error;
    }

    if (reminder.immediate) {
      try {
        await deliverImmediately(ddb, tableName, deptId, reminder.item, envelope, DELIVERY_SPEC);
      } catch (error) {
        logError(`${LOG_PREFIX}.immediate_failed`, error, envelope.eventId, {
          defectId: reminder.item.subjectId,
        });
        emitOutcomeMetric(METRIC_NAMESPACE, 'ApparatusDefectImmediateFailed');
        throw error;
      }
    }
  }
};
