import { DEMO_FLEET, demoMemberName } from '../../lib/demoRoster';
import type { InboxNotification, NotificationDigestItem, NotificationPreference } from './types';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOW = Date.now();

/** YYYY-MM-DD for `offsetDays` from today. */
function isoDate(offsetDays: number): string {
  return new Date(NOW + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

const ENGINE_301 = DEMO_FLEET[1].unitId;
const TRUCK_304 = DEMO_FLEET[2].unitId;
const ENGINE_305 = DEMO_FLEET[3].unitId;
const RESCUE_300 = DEMO_FLEET[0].unitId;

function notification(
  notificationId: string,
  category: string,
  summary: string,
  items: NotificationDigestItem[],
  hoursAgo: number,
  readHoursAgo: number | null,
): InboxNotification {
  return {
    notificationId,
    category,
    summary,
    items,
    createdAt: NOW - hoursAgo * HOUR_MS,
    readAt: readHoursAgo === null ? null : NOW - readHoursAgo * HOUR_MS,
  };
}

function memberItem(memberId: string, detail: string, dueDate?: string): NotificationDigestItem {
  return {
    subjectId: `${memberId}:${detail}`,
    title: demoMemberName(memberId),
    detail,
    ...(dueDate ? { dueDate } : {}),
    link: { kind: 'member', id: memberId },
  };
}

// The last three days of the signed-in chief's inbox, newest first. The top four are unread -
// the top bar badge reads 4. Dispatch, shift and training items use the backend's kebab-case
// category keys; those without a label in labels.ts show the key as their title.
let notifications: InboxNotification[] = [
  notification(
    'notif-demo-12',
    'dispatch',
    `Automatic fire alarm, 320 Old Town Rd - ${ENGINE_301} and ${TRUCK_304} due`,
    [
      {
        subjectId: 'NFD-26-0412',
        title: 'NFD-26-0412',
        detail: 'Old Town Road Assisted Living. Alarm company reports water flow, 2nd floor east.',
        link: { kind: 'incident' },
      },
    ],
    0.6,
    null,
  ),
  notification(
    'notif-demo-11',
    'apparatus-defect',
    `${TRUCK_304} reported out of service`,
    [
      {
        subjectId: 'DEF-304-aerial',
        title: TRUCK_304,
        detail: `aerial hydraulic leak at the turntable, reported by ${demoMemberName('m-9')}`,
        link: { kind: 'apparatus', id: TRUCK_304 },
      },
    ],
    2,
    null,
  ),
  notification(
    'notif-demo-10',
    'shift-open',
    'Tonight 18:00-06:00 standby still needs a driver',
    [
      {
        subjectId: 's-tonight:DRIVER',
        title: 'Station 1',
        detail: `DRIVER seat open tonight 18:00-06:00; ${demoMemberName('m-13')} asked to swap out`,
      },
    ],
    3,
    null,
  ),
  notification(
    'notif-demo-9',
    'inventory-reorder',
    '2 supplies below par',
    [
      {
        subjectId: 'foam-3pct',
        title: 'Class A foam (3%)',
        detail: '4 pails on hand, par 8',
        link: { kind: 'consumables' },
      },
      {
        subjectId: 'absorbent',
        title: 'Absorbent (Speedi-Dri)',
        detail: '6 bags on hand, par 10',
        link: { kind: 'consumables' },
      },
    ],
    5,
    null,
  ),
  notification(
    'notif-demo-8',
    'apparatus-test-due',
    '2 tests due',
    [
      {
        subjectId: `${ENGINE_301}:HOSE`,
        title: ENGINE_301,
        detail: `annual hose test due ${isoDate(16)}`,
        dueDate: isoDate(16),
        link: { kind: 'apparatus', id: ENGINE_301 },
      },
      {
        subjectId: 'SCBA-4471:SCBA_FLOW',
        title: ENGINE_301,
        detail: `SCBA SCBA-4471 flow test was due ${isoDate(-2)}`,
        dueDate: isoDate(-2),
        link: { kind: 'apparatus', id: ENGINE_301 },
      },
    ],
    9,
    7,
  ),
  notification(
    'notif-demo-7',
    'cert-expiry',
    '2 of your certifications expire within 60 days',
    [
      { certId: 'FF2-0415', expiryDate: isoDate(26) },
      { certId: 'CPR-3310', expiryDate: isoDate(41) },
    ],
    24,
    20,
  ),
  notification(
    'notif-demo-6',
    'training-reminder',
    'Drill Tuesday 19:00: SCBA confidence course',
    [
      {
        subjectId: 'drill-scba-confidence',
        title: 'Drill',
        detail: `Tuesday 19:00 at Station 1, led by ${demoMemberName('m-7')}. Bring your SCBA mask.`,
      },
    ],
    27,
    22,
  ),
  notification(
    'notif-demo-5',
    'cert-expiry-officer',
    '3 members with certifications expiring within 30 days',
    [
      memberItem('m-8', `HAZMAT-0081 expires ${isoDate(11)}`, isoDate(11)),
      memberItem('m-13', `PUMP-0112 expires ${isoDate(18)}`, isoDate(18)),
      memberItem('m-17', `FF1-0777 expires ${isoDate(27)}`, isoDate(27)),
    ],
    31,
    22,
  ),
  notification(
    'notif-demo-4',
    'neris-accepted',
    'NERIS accepted 2 incident reports',
    [
      {
        subjectId: 'NFD-26-0409',
        title: 'NFD-26-0409',
        detail: 'Structure fire, 48 White Plains Rd - accepted',
        link: { kind: 'incident' },
      },
      {
        subjectId: 'NFD-26-0410',
        title: 'NFD-26-0410',
        detail: 'Motor vehicle accident, Route 111 at Daniels Farm Rd - accepted',
        link: { kind: 'incident' },
      },
    ],
    48,
    40,
  ),
  notification(
    'notif-demo-3',
    'ppe-expiry-officer',
    '2 PPE items past NFPA 1851 retirement',
    [
      memberItem('m-23', 'turnout coat issued 2015-03-02, retire by 2025-03-02', '2025-03-02'),
      memberItem('m-21', 'boots issued 2016-06-01, retire by 2026-06-01', '2026-06-01'),
    ],
    53,
    40,
  ),
  notification(
    'notif-demo-2',
    'apparatus-status',
    `${ENGINE_305} returned to service`,
    [
      {
        subjectId: `${ENGINE_305}:IN_SERVICE`,
        title: ENGINE_305,
        detail: `back in service after the annual pump test, by ${demoMemberName('m-9')}`,
        link: { kind: 'apparatus', id: ENGINE_305 },
      },
    ],
    68,
    60,
  ),
  notification(
    'notif-demo-1',
    'dispatch',
    `Motor vehicle accident, Route 111 at Daniels Farm Rd - ${RESCUE_300} and ${ENGINE_301} due`,
    [
      {
        subjectId: 'NFD-26-0410',
        title: 'NFD-26-0410',
        detail: 'Two vehicles, injuries reported. Trumbull PD on scene.',
        link: { kind: 'incident' },
      },
    ],
    71,
    70,
  ),
];

let preferences: NotificationPreference[] = [];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** VITE_DEMO handlers for notification-service's inbox and preferences routes. */
export function tryHandleNotificationExtras(
  parts: string[],
  method: string,
  body: Record<string, unknown>,
): Response | undefined {
  if (parts[0] !== 'notifications') return undefined;

  if (parts.length === 1 && method === 'GET') {
    return json({ items: notifications, nextCursor: null });
  }
  if (parts[1] === 'preferences' && parts.length === 2) {
    if (method === 'GET') return json({ preferences });
    if (method === 'PUT') {
      const saved: NotificationPreference = {
        category: body.category as string,
        channels: body.channels as NotificationPreference['channels'],
      };
      preferences = [...preferences.filter((p) => p.category !== saved.category), saved];
      return json({ ...saved, updatedAt: Date.now() });
    }
  }
  if (parts.length === 3 && parts[2] === 'read' && method === 'POST') {
    const id = decodeURIComponent(parts[1] ?? '');
    const found = notifications.find((n) => n.notificationId === id);
    if (!found) {
      return json({ type: 'about:blank', title: 'Not found', status: 404, traceId: 'demo' }, 404);
    }
    const readAt = Date.now();
    notifications = notifications.map((n) => (n.notificationId === id ? { ...n, readAt } : n));
    return json({ notificationId: id, readAt });
  }

  return undefined;
}
