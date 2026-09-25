# training-service

## Purpose & Boundaries

Certifications, expiry alerting, drills, training hours, transcripts. Service 6 of 10, Wave 3. Logical service on the shared `platform-service` physical table.

## Interfaces

Base path `/api/v1/training/...`.

| Method | Path | Description | Auth |
|---|---|---|---|
| GET | `/members/{memberId}/certifications` | Cert records (F3.1) | Cognito |
| POST | `/members/{memberId}/certifications` | Add cert incl. attachment | Cognito(admin) |
| GET | `/certifications/expiring` | Upcoming expirations, configurable lead time (F3.2) | Cognito(admin) |
| GET | `/events` | Drill/training event schedule (F3.3) | Cognito |
| POST | `/events/{eventId}/signup` | Sign up / record attendance | Cognito |
| GET | `/hours` | Training hours by member/category/period (F3.4) | Cognito |
| GET | `/reports/iso` | ISO-aligned training hour report (F3.5) | Cognito(admin) |
| GET | `/members/{memberId}/transcript` | Exportable transcript (F3.6) | Cognito |
| GET | `/health/liveness` \| `/health/readiness` | Health | none |

## Data Ownership

On `platform-service` physical table.

- **CERTIFICATION** — `pk=DEPT#{deptId}#MEMBER#{memberId}`, `sk=CERT#{certId}`. `attachmentS3Key` **PII** (scanned cert card typically shows holder's name/DOB). `status`: `CURRENT`|`EXPIRED`|`REVOKED`. GSI2: `DEPT#{deptId}#DUE#CERTIFICATION#{YYYY-MM}` for expiry scans.
- **TRAINING_EVENT** — `pk=DEPT#{deptId}#TRAINING_EVENT#{eventId}`, `sk=METADATA`.
- **TRAINING_ATTENDANCE** — `sk=ATTENDEE#{memberId}`. `category` denormalized from event for ISO rollups (F3.5).

## Events Produced

- `training.expiry.due` (canonical name; renamed from `cert.expiry.due` — the pre-rename name violated the domain-is-owning-service convention) — daily scheduled Certification Expiry Scanner → `notification-service`. Payload: `{memberId, certId, expiryDate, leadDays}`.

## Events Consumed

None named directly. `MEMBER_QUALIFICATION.grantedByCertId`/`currentlyEligible` linkage (F3.7) is maintained by this service's own writes against `personnel-service`'s `MEMBER_QUALIFICATION` entity — same physical table, no cross-service call needed, but cross-reference `eventing-architect` if this moves to fully event-driven propagation.

## Dependencies

**Internal:** `notification-service` (expiry routing). Shares the physical table with `personnel-service` (MEMBER_QUALIFICATION currency link, F3.7).

**External:** S3 (`nichols-boxalarm-platform-assets`) for cert attachments.

## Gotchas & Constraints

- **Event rename is canonical, not optional:** `cert.expiry.due` → `training.expiry.due` because `domain` in an event name is always the owning service's short name (training-service owns cert expiry), never the entity's informal domain. The old SNS topic name (`moonaan-prod-training-topic`) already agreed with the new name — that mismatch was the original tell.
- **Digest batching for the resulting notification is required, not optional** (owned by notification-service, but the trigger volume comes from this service's daily scanner) — one push per expiring item per member per day is explicitly the failure mode being avoided.

## Source Sections

- Backend §1.1 Service inventory (`:120-146`)
- Backend §1.4 Event naming reconciliation (`:262-264`)
- Backend §2 training-service API endpoints (`:371-384`)
- Data Model §3.3 CERTIFICATION, TRAINING_EVENT, TRAINING_ATTENDANCE (`:967-1080`)
- Data Model §4 Access patterns 23-26 (`:1390-1393`)
- Events §Other domains, `training.expiry.due` (`:1787-1817`)
