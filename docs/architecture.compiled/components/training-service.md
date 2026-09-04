# training-service

## Purpose & Boundaries
Certifications, expiry alerting, drills, training hours, transcripts. Wave 3. Data on the shared `platform-service` table.

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

## Data Ownership
On the shared `platform-service` table.

- **CERTIFICATION (F3.1)** — `pk=DEPT#{deptId}#MEMBER#{memberId}`, `sk=CERT#{certId}`. `status` CURRENT|EXPIRED|REVOKED. `attachmentS3Key` → `nichols-boxalarm-platform-assets` bucket. `gsi1pk/sk` = `MEMBER#{memberId}` / `CERTIFICATION#{expiryDate}`. `gsi2pk/sk` = `DEPT#{deptId}#DUE#CERTIFICATION#{YYYY-MM}` / `{expiryDate}#{certId}`.
- **TRAINING_EVENT (F3.3)** — `pk=DEPT#{deptId}#TRAINING_EVENT#{eventId}`, `sk=METADATA`. `gsi3pk/sk` = `DEPT#{deptId}#TRAINING_EVENT` / `{startAt}`.
- **TRAINING_ATTENDANCE (F3.4)** — `sk=ATTENDEE#{memberId}`. `category` denormalized from event for ISO rollups (F3.5). `gsi1pk/sk` = `MEMBER#{memberId}` / `TRAINING_ATTENDANCE#{eventStartAt}`.
- Owns the `grantedByCertId` relationship into `personnel-service`'s `MEMBER_QUALIFICATION` (F3.7 — expired cert affects eligibility, cross-referenced not owned here).

## Events Produced
- `cert.expiry.due` — Certification Expiry Scanner (daily scheduled Lambda). `{memberId, certId, expiryDate, leadDays}`. Consumer: `notification-service` (member + training officer). Transport: `boxalarm-{env}-platform-bus` → `training-notify-queue` + DLQ.

## Events Consumed
None named.

## Dependencies
**Internal:** publishes to `notification-service` (cert expiry). Feeds `personnel-service`'s `MEMBER_QUALIFICATION.currentlyEligible` derivation via `grantedByCertId` (F3.7 link, ID reference, not a live call). Feeds `reporting-service` (ISO training-hour rollups, F3.5).
**External:** none.

## Gotchas & Constraints
- **Digest batching applies to `cert.expiry.due` at the notification layer** — the expiry scanner runs daily and would otherwise emit one push per expiring item; `notification-service` groups notifications per member per category per day (this is a `notification-service` obligation, not a `training-service` one, but the event volume this service produces must not assume per-event delivery).
- ISO training-hour reporting (F3.5) is app-side aggregation over GSI3 `TRAINING_EVENT` query results, not a dedicated rollup store.
- `CERTIFICATION.status` derives `MEMBER_QUALIFICATION.currentlyEligible` in `personnel-service` — an expired cert must correctly propagate eligibility loss (F3.7), which in turn is what feeds the alerting eligibility snapshot indirectly via `personnel.eligibility.changed`.
- No TTL on cert/training records — historical compliance data.

## Source Sections
- Backend §1.1 Bounded contexts / service table — lines 116–142
- API endpoints: training-service — lines 336–347
- Data Model §3.3 CERTIFICATION, TRAINING_EVENT, TRAINING_ATTENDANCE, MEMBER_QUALIFICATION (F3.7 cross-ref) — lines 798–923
- Data Model §4 Access patterns #13, #23–26 — lines 1195–1208
- Events §3, §5 (cert.expiry.due producer/consumer/transport) — lines 1398–1420, 1503–1522
- Testing §2 F3 test matrix — lines 1924–1934
