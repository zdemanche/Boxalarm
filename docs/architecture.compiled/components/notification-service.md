# notification-service

## Purpose & Boundaries
Non-alert member/officer notification: cert expiry (F3.2), defect routing to apparatus officer (F4.3), testing-due (F4.7), PPE expiry, reorder thresholds (F5.3), shift-coverage gaps. Notification preferences, in-app inbox, digest batching. Wave 1. Service 10 — did not exist in the original service list; reconciled in as a **CANONICAL** addition because the Events section routed five event types to a "Notification Service" that had no owning service until this reconciliation.

**Failure domain is the LOB plane, explicitly** — this is the load-bearing boundary of this service's existence. It shares **no** SQS queue, no Lambda concurrency reservation, no SNS topic, and **no provider account** with `alerting-service`. A notification-service failure or a flood of cert-expiry notices cannot consume capacity the alert path depends on (N1.5). It consumes from `boxalarm-{env}-platform-bus` only, never from the alerting FIFO topic.

## Interfaces
Base path `/api/v1/notifications/...` (inferred from the entity/endpoint description — the source document gives these four endpoints without a full table entry alongside the other 9 services' endpoint tables).

| Method | Path | Description | Auth |
|---|---|---|---|
| GET | `/notifications` | Inbox, paginated | Cognito |
| POST | `/notifications/{id}/read` | Mark notification read | Cognito |
| GET | `/notifications/preferences` | Get notification preferences | Cognito |
| PUT | `/notifications/preferences` | Update notification preferences | Cognito |

## Data Ownership
On the shared `platform-service` table.

- **NOTIFICATION_PREFERENCE** — `sk = NOTIFPREF#{memberId}#{category}` — channel opt-ins and digest cadence per category.
- **NOTIFICATION** — `sk = NOTIF#{memberId}#{ts}#{notificationId}` — in-app inbox record, `readAt` field, TTL 180 days.

## Events Produced
None — this is a pure consumer/router service; it does not publish domain events onward (it triggers push/FCM/email sends directly, not further EventBridge events).

## Events Consumed
All via `boxalarm-{env}-platform-bus`, rule-routed to per-consumer SQS queues + DLQ:
- `cert.expiry.due` (from `training-service`) → `training-notify-queue`
- `apparatus.defect.reported` (from `apparatus-service`) → `apparatus-notify-queue`
- `apparatus.test.due` (from `apparatus-service`) → `apparatus-notify-queue`
- `ppe.expiry.due` (from `inventory-service`) → `inventory-notify-queue`
- `inventory.reorder.due` (from `inventory-service`) → `inventory-notify-queue`
- `scheduling.coverage_gap.detected` (from `personnel-service`) → `scheduling-notify-queue`

## Dependencies
**Internal:** consumes events from `training-service`, `apparatus-service`, `inventory-service`, `personnel-service`. Shares the `platform-service` table for its own entities.
**External:** APNs/FCM via a **separate, non-critical notification channel** (distinct channel ID, not the Critical Alerts channel — so a routine cert reminder can never present as a dispatch), plus email. **No SMS and no voice in v1** — those channels are reserved to the alerting plane to keep cost and failure domain separate.

## Gotchas & Constraints
- **Must never share infrastructure with `alerting-service`** — no shared queue, concurrency reservation, SNS topic, or provider account. This is the entire reason this service exists as a separate deployment unit rather than a handler inside another LOB service; a regression test (`NOTIF-ISO` in the test matrix) verifies this by chaos-testing this service and asserting alerting delivery is unaffected.
- **Digest batching is required, not optional** — expiry scanners run daily and would otherwise emit one push per expiring item; notifications are grouped per member per category per day.
- **Two events this service routes to were originally undefined and had to be reconciled in:** `apparatus.defect.reported` and `inventory.reorder.due` (see the owning services' sheets for their payload shapes). F4.3 was the requirement that first exposed the gap.
- Test-matrix rows are required for F3.2, F4.3, F4.7, F5.3, and shift-coverage delivery (F2.10n) — each is its own explicit row in the F1/N1 test matrix despite being LOB-tier, because delivery must be proven, not assumed.

## Source Sections
- Backend §1.1 Bounded contexts / service table + `notification-service` CANONICAL note — lines 116–140
- Events §Reconciliations item 4 (service name mapping) — lines 1317–1329
- Events §Reconciliations item 7 (apparatus.defect.reported, inventory.reorder.due newly defined) — lines 1337–1345
- Events §3, §5 (producer/consumer/transport table, all five consumed event types) — lines 1398–1420, 1503–1522
- Eventing Architecture §1 Design rule (isolation from alerting) — lines 1348–1354
- Testing §2 F1/N1 test matrix, notification rows F3.2n/F4.3n/F4.7n/F5.3n/F2.10n/NOTIF-ISO — lines 1897–1903
