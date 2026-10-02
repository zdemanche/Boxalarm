import { NERIS_NO_ACTIVITY_CATEGORY } from '../reminders/categories.js';
import { createReminderConsumer, requireString } from './reminderIngest.js';

const LABEL = 'neris.no_activity.due';

/**
 * neris.no_activity.due (incident-service's nightly reconciliation, once per month that
 * closed with no calls and no report filed) -> a neris-no-activity reminder for the chief and
 * admin to file the NERIS no-activity report.
 */
export const handler = createReminderConsumer({
  label: LABEL,
  acceptedEventTypes: new Set([LABEL]),
  logPrefix: 'notification.nerisNoActivity',
  metricPrefix: 'NerisNoActivity',
  toReminder: ({ payload }) => {
    const month = requireString(payload, 'month', LABEL);
    return {
      deptId: requireString(payload, 'deptId', LABEL),
      category: NERIS_NO_ACTIVITY_CATEGORY,
      item: {
        subjectId: `no-activity:${month}`,
        title: `No calls logged in ${month}`,
        detail: 'file the NERIS no-activity report',
        link: { kind: 'incident' },
      },
    };
  },
});
