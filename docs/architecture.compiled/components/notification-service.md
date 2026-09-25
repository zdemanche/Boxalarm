# notification-service

## Purpose & Boundaries

**Non-alert** member/officer notification: cert expiry (F3.2), defect routing to apparatus officer (F4.3), testing-due (F4.7), PPE expiry, reorder thresholds (F5.3), shift-coverage gaps. Notification preferences, in-app inbox, digest batching. Service 10 of 10, Wave 1. Logical service on the shared `platform-service` physical table. **Failure domain is the LOB plane, explicitly** — shares no SQS queue, no Lambda concurrency reservation, no SNS topic, and no provider account with `alerting-service`; a flood of cert-expiry notices cannot consume capacity the alert path depends on (N1.5). Consumes from `boxalarm-{env}-platform-bus` only, never the alerting FIFO topic.

## Interfaces

Base path is `/notifications/...` **verbatim, not `/api/v1/notification/...`** — this service predates the `/api/v1/{service}/...` convention and its own contract note is the authority.

| Method | Path | Description | Auth |
|---|---|---|---|
| GET | `/notifications` | In-app inbox, paginated | Cognito |
| POST | `/notifications/{id}/read` | Mark a notification read | Cognito |
| GET | `/notifications/preferences` | Channel opt-ins and digest cadence per category | Cognito |
| PUT | `/notifications/preferences` | Update preferences | Cognito |
| GET | `/notifications/health/liveness` \| `/notifications/health/readiness` | Health | none |

## Data Ownership

On `platform-service` physical table.

- **NOTIFICATION_PREFERENCE** — `sk = NOTIFPREF#{memberId}#{category}`. Channel opt-ins and digest cadence per category.
- **NOTIFICATION** — `sk = NOTIF#{memberId}#{ts}#{notificationId}`. In-app inbox record with `readAt`. **TTL 180 days.**

## Events Produced

None (this service is a pure consumer/router).

## Events Consumed

- `training.expiry.due` → `training-notify-queue`
- `apparatus.test.due` → `apparatus-notify-queue`
- `apparatus.defect.reported` → `apparatus-notify-queue`
- `inventory.expiry.due` → `inventory-notify-queue`
- `inventory.reorder.due` → `inventory-notify-queue`
- `scheduling.coverage_gap.detected` → `scheduling-notify-queue`

All via `boxalarm-{env}-platform-bus` rule routing to per-event-type SQS queues + DLQs, `maxReceiveCount: 5` (standard LOB tier).

## Dependencies

**Internal:** consumes events from `training-service`, `apparatus-service`, `inventory-service`, `personnel-service`/scheduling. **Never** subscribes to the alerting SNS FIFO topic.

**External:** APNs/FCM via a **separate, non-critical notification channel** (distinct channel ID from Critical Alerts, so OS-level treatment differs and a routine cert reminder can never present as a dispatch), plus email. **No SMS and no voice in v1** — reserved to the alerting plane to keep cost and failure domain separate.

## Gotchas & Constraints

- **Digest batching is required, not optional.** Expiry scanners run daily and would otherwise emit one push per expiring item — notifications are grouped per member per category per day.
- **Must never share a queue, concurrency reservation, SNS topic, or provider account with `alerting-service`** — this is the entire point of this service existing as service 10 rather than being folded into the notification paths of the services that trigger it. Test obligation `NOTIF-ISO` in the Testing Architecture verifies this directly (chaos test).
- **This service "previously existed in no service list"** — it was reconciled into the canonical 10-service inventory specifically because the Events section routed 5 event types to a "Notification Service" that had no deployment-unit definition until this reconciliation.
- **Test-matrix rows required** for F3.2, F4.3, F4.7, F5.3, and shift-coverage delivery — named explicitly as an obligation the Testing section's matrix must add.

## Source Sections

- Backend §1.1 Service inventory, canonical notification-service contract note (`:120-146`, esp. `:137-144`)
- Backend §2 notification-service API endpoints (`:431-443`)
- Data Model NOTIFICATION_PREFERENCE / NOTIFICATION entities (per §1.1's canonical note, `:141`)
- Data Model §3.4 Retention — NOTIFICATION TTL (implied by 180-day inbox retention, `:141`)
- Events §4 Service-name mapping (Notification Service → notification-service) (`:1527-1540`)
- Events §7 new events table, `apparatus.defect.reported`/`inventory.reorder.due` (`:1548-1556`)
- Events §Other domains, producer/consumer table (`:1787-1821`)
- Eventing Architecture §1 isolation invariant, NOTIF-ISO test (`:1559-1565`)
- Testing §2 NOTIF-ISO test matrix row (`:2219`)
