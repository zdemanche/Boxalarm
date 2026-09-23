# notification-service

## Purpose & Boundaries
Non-alert member/officer notification: cert expiry (F3.2), defect routing to apparatus officer (F4.3), testing-due (F4.7), PPE expiry, reorder thresholds (F5.3), shift-coverage gaps. Notification preferences, in-app inbox, digest batching. Service 10 in the bounded-context list; was previously undefined ("Notification Service") in the Events section before reconciliation gave it a canonical home.

**Failure domain is the LOB plane, explicitly** - shares no SQS queue, no Lambda concurrency reservation, no SNS topic, and no provider account with `alerting-service`. A notification-service failure, or a flood of cert-expiry notices, cannot consume capacity the alert path depends on (N1.5). Consumes exclusively from `boxalarm-{env}-platform-bus`, never the alerting FIFO topic.

## Interfaces
Base path `/api/v1/notifications/...` (implied from the four endpoints named in Backend section 1.1).

| Method | Path |
|---|---|
| GET | `/notifications` (inbox, paginated) |
| POST | `/notifications/{id}/read` |
| GET | `/notifications/preferences` |
| PUT | `/notifications/preferences` |

## Data Ownership
On the shared `platform-service` table:
- `NOTIFICATION_PREFERENCE` - `sk=NOTIFPREF#{memberId}#{category}` - channel opt-ins and digest cadence per category.
- `NOTIFICATION` - `sk=NOTIF#{memberId}#{ts}#{notificationId}` - in-app inbox record, `readAt`, TTL 180 days.

## Events Produced
None (a consumer service).

## Events Consumed
- `cert.expiry.due` (from `training-service`)
- `apparatus.test.due` (from `apparatus-service`)
- `apparatus.defect.reported` (from `apparatus-service`, routes to apparatus officer role)
- `ppe.expiry.due` (from `inventory-service`)
- `inventory.reorder.due` (from `inventory-service`, routes to quartermaster/admin role)
- `scheduling.coverage_gap.detected` (from `personnel-service`)

All via `boxalarm-{env}-platform-bus` rule -> per-domain notify queue + DLQ.

## Dependencies
- Internal: `training-service`, `apparatus-service`, `inventory-service`, `personnel-service` (all event producers only - no synchronous calls).
- External: APNs/FCM via a separate, non-critical notification channel (distinct channel ID from the alerting Critical Alerts channel so a routine cert reminder can never present as a dispatch), plus email. No SMS and no voice in v1.

## Gotchas & Constraints
- Digest batching is required, not optional - expiry scanners run daily and would otherwise emit one push per expiring item; notifications are grouped per member per category per day.
- Must never share a queue, concurrency reservation, or provider account with `alerting-service` - this is a test-matrix row (NOTIF-ISO) in its own right, verified by chaos test (saturate this service, assert alerting unaffected).
- Test-matrix rows are required for F3.2, F4.3, F4.7, F5.3, and shift-coverage delivery - all listed explicitly as a named obligation when this service was reconciled into existence.

## Source Sections
- Backend section 1.1 Bounded contexts (service #10, CANONICAL reconciliation note), lines 129-140
- Eventing section 1 reconciliation items 4 and 7, lines 1428-1456
- Eventing section 3, 5 (producer/consumer/transport table), lines 1520-1544, 1676-1698
- Testing section 2 F1/N1 matrix (notification test rows, NOTIF-ISO), lines 2091-2097
