import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import type { SQSEvent } from 'aws-lambda';
import { createDynamoClient, readNotificationConfig } from '../dynamoClient.js';
import { APPARATUS_STATUS_CATEGORY, type ReminderItem } from '../reminders/categories.js';
import { deliverImmediately, type ImmediateDeliverySpec } from './immediateDelivery.js';
import {
  logError,
  MalformedEventError,
  parseEnvelope,
  requireString,
  METRIC_NAMESPACE,
  type EventEnvelope,
} from './reminderIngest.js';

const LABEL = 'apparatus.serviceStatus.changed';
const LOG_PREFIX = 'notification.apparatusStatus';

/**
 * The same immediate pipeline as the out-of-service defect: idempotent inbox record keyed on
 * the eventId, then the mute-checked non-critical push and email, each behind its own claim.
 */
const DELIVERY_SPEC: ImmediateDeliverySpec = {
  category: APPARATUS_STATUS_CATEGORY,
  pushMarker: 'STATUSPUSH',
  emailMarker: 'STATUSEMAIL',
  metricPrefix: 'ApparatusStatus',
  logPrefix: LOG_PREFIX,
  noRecipientsError: 'no active APPARATUS, OFFICER or CHIEF holder',
};

interface StatusChange {
  readonly deptId: string;
  readonly item: ReminderItem;
}

function toStatusChange({ payload, eventTime }: EventEnvelope): StatusChange {
  // The inbox record is keyed on the event time (buildOutboxRecord always sets it); without it
  // a redelivery could not find the record it already wrote.
  if (!eventTime || !Number.isFinite(Date.parse(eventTime))) {
    throw new MalformedEventError(LABEL);
  }
  const unitId = requireString(payload, 'unitId', LABEL);
  const status = requireString(payload, 'status', LABEL);
  const reason = typeof payload.reason === 'string' && payload.reason ? payload.reason : undefined;
  const detail =
    status === 'OUT_OF_SERVICE'
      ? `out of service${reason ? `: ${reason}` : ''}`
      : 'returned to service';
  return {
    deptId: requireString(payload, 'deptId', LABEL),
    item: {
      subjectId: unitId,
      title: unitId,
      detail,
      // The web apparatus detail route is keyed by the display unitId the event carries.
      link: { kind: 'apparatus', id: unitId },
    },
  };
}

/**
 * apparatus.serviceStatus.changed (apparatus-service outbox; owed-stories review minor 10) ->
 * an immediate inbox record for every APPARATUS, OFFICER and CHIEF member, plus the
 * non-critical push and email through the same pipeline as the out-of-service defect, under
 * the 'apparatus-status' mute category. Idempotent on eventId end to end: the inbox Put is
 * conditional, each channel send is claim-guarded, so a redelivery is a no-op for anyone
 * already delivered. No digest row — a status change is news now, not tomorrow.
 */
export const handler = async (event: SQSEvent): Promise<void> => {
  const { tableName } = readNotificationConfig(process.env);
  const ddb = createDynamoClient(process.env);

  for (const record of event.Records) {
    let envelope: EventEnvelope;
    let change: StatusChange;
    try {
      envelope = parseEnvelope(record.body, new Set([LABEL]), LABEL);
      change = toStatusChange(envelope);
    } catch (error) {
      logError(`${LOG_PREFIX}.malformed_event`, error, record.messageId);
      throw error;
    }
    const deptId = toVerifiedDeptId({ deptId: change.deptId });

    try {
      await deliverImmediately(ddb, tableName, deptId, change.item, envelope, DELIVERY_SPEC);
    } catch (error) {
      logError(`${LOG_PREFIX}.immediate_failed`, error, envelope.eventId, {
        unitId: change.item.subjectId,
      });
      emitOutcomeMetric(METRIC_NAMESPACE, 'ApparatusStatusImmediateFailed');
      throw error;
    }
  }
};
