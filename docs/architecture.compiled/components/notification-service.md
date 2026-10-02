# Notification Service

## Purpose & Boundaries
NON-alert member/officer notifications: cert expiry (F3.2), defect routing to apparatus officer (F4.3), testing-due (F4.7), PPE expiry, reorder thresholds (F5.3), shift-coverage gaps. Preferences, in-app inbox, digest batching (required: grouped per member per category per day). Failure domain = LOB plane: shares NO SQS queue, Lambda concurrency reservation, SNS topic, or provider account with alerting; consumes only from `boxalarm-{env}-platform-bus`, never the alerting FIFO topic. Channels: APNs/FCM via separate non-critical channel (distinct channel ID, not Critical Alerts) + email. No SMS, no voice in v1.

## Interfaces
Paths verbatim (not `/api/v1`): GET `/notifications` (inbox, paginated); POST `/notifications/{id}/read`; GET/PUT `/notifications/preferences`; GET `/notifications/health/liveness|readiness`. All Cognito.

## Data Ownership
Platform table: `NOTIFICATION_PREFERENCE` (`sk=NOTIFPREF#{memberId}#{category}`), `NOTIFICATION` (`sk=NOTIF#{memberId}#{ts}#{notificationId}`, `readAt`, TTL 180 days).

## Events Produced
absent — the source document does not address this

## Events Consumed
`training.expiry.due`, `apparatus.test.due`, `inventory.expiry.due`, `inventory.reorder.due`, `scheduling.coverage_gap.detected`, `apparatus.defect.reported` (routes to apparatus officer role), `neris.incident.missing`; queues `training-notify-queue`, `apparatus-notify-queue`, `inventory-notify-queue`, `scheduling-notify-queue`. Terminal NERIS send failure puts inbox item immediately (not digest-only).

## Dependencies
internal: training-service, apparatus-service, inventory-service, personnel-service, incident-service (producers). external: APNs/FCM, email provider (unnamed).

## Gotchas & Constraints
- Isolation test NOTIF-ISO required (shares no queue/concurrency/provider with alerting).
- Test-matrix rows required: F3.2n, F4.3n, F4.7n, F5.3n, F2.10n.
- Email provider: absent.

## Source Sections
§1.1 notification note 135–146; §2 notification API 503–514; Events item 7 1640–1647; Testing matrix 2306–2311.
