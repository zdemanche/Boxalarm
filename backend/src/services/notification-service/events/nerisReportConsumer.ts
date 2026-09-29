import { NERIS_REJECTED_CATEGORY } from '../reminders/categories.js';
import { createReminderConsumer, optionalString, requireString } from './reminderIngest.js';

const REJECTED = 'neris.incident.rejected';
const FAILED = 'neris.incident.failed';

/**
 * neris.incident.rejected | neris.incident.failed (incident-service's NERIS status poller)
 * -> a neris-rejected reminder for the report's owner, linking to the report so they can fix
 * and resubmit it. One reminder per NERIS status change (subjectId carries the status time).
 */
export const handler = createReminderConsumer({
  label: 'neris.incident.rejected',
  acceptedEventTypes: new Set([REJECTED, FAILED]),
  logPrefix: 'notification.nerisReport',
  metricPrefix: 'NerisReport',
  toReminder: ({ eventType, payload }) => {
    const incidentId = requireString(payload, 'incidentId', REJECTED);
    const ownerId = requireString(payload, 'ownerId', REJECTED);
    const incidentNumber = optionalString(payload, 'incidentNumber') ?? incidentId;
    const statusAt = optionalString(payload, 'statusAt') ?? '';
    return {
      deptId: requireString(payload, 'deptId', REJECTED),
      category: NERIS_REJECTED_CATEGORY,
      memberId: ownerId,
      item: {
        subjectId: `${incidentId}:${eventType}:${statusAt}`,
        title: `Report ${incidentNumber}`,
        detail:
          eventType === REJECTED
            ? 'was rejected by NERIS: fix it and resubmit'
            : "couldn't be processed by NERIS: check the submission and resubmit",
        link: { kind: 'incident', id: incidentId },
      },
    };
  },
});
