# Notification Service

## Purpose & Boundaries
Non-alert member/officer notifications: cert expiry (F3.2), defect routing to apparatus officer (F4.3), testing-due (F4.7), PPE expiry, reorder thresholds (F5.3), shift-coverage gaps. Preference management, in-app inbox, digest batching (required: group per member per category per day). Service 10, wave 1, LOB failure domain. Channels: APNs/FCM on a separate non-critical channel in the same app (distinct channel ID, never Critical Alerts) plus email. NO SMS, NO voice in v1. Shares `platform` table.

## Interfaces
Canonical paths (NOT under /api/v1; Backend §1.1 note is source of truth): GET `/notifications` (paginated inbox), POST `/notifications/{id}/read`, GET `/notifications/preferences`, PUT `/notifications/preferences`, GET `/notifications/health/liveness`, GET `/notifications/health/readiness` (all Cognito except health).

## Data Ownership
NOTIFICATION_PREFERENCE `sk=NOTIFPREF#{memberId}#{category}` (channel opt-ins, digest cadence); NOTIFICATION `sk=NOTIF#{memberId}#{ts}#{notificationId}` (`readAt`, TTL 180 days). Both on `platform` table.

## Events Produced
absent — the source document does not address this.

## Events Consumed
From `boxalarm-{env}-platform-bus`: `training.expiry.due` (`training-notify-queue`), `apparatus.test.due`, `apparatus.defect.reported` (`apparatus-notify-queue`, routes to apparatus officer role), `inventory.expiry.due`, `inventory.reorder.due` (`inventory-notify-queue`, routes to quartermaster/admin), `scheduling.coverage_gap.detected` (`scheduling-notify-queue`); `neris.incident.missing`/terminal NERIS failures (immediate inbox, not digest-only). Each queue + DLQ maxReceive 5.

## Dependencies
internal: training, apparatus, inventory, personnel, incident services; mobile-app. external: APNs/FCM (read-only shared signing credentials), email.

## Gotchas & Constraints
- Shares NO queue, concurrency reservation, SNS topic, table, or writable resource with alerting plane; never subscribes to alerting FIFO topic. Only shared item: three APNs/FCM signing secrets, read-only (pinned by test). Documented alternative not built: separate APNs .p8 key + FCM service account for LOB.
- Test-matrix rows required for F3.2n, F4.3n, F4.7n, F5.3n, F2.10n, NOTIF-ISO.
- Expiry scanners are daily; without digest batching they would push one per item.

## Source Sections
Backend §1.1 service 10 note (139-146); §2 notification-service (503-514); Events reconciliations 4, 7 (1619-1647); §5 table (1903-1909); Testing matrix (2306-2311)
