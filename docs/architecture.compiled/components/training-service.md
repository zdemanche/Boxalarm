# training-service

## Purpose & Boundaries
Certifications, expiry alerting, drills/training events, training hours, and exportable transcripts.

## Interfaces
Base path `/api/v1/training/...`.

| Method | Path | Auth |
|---|---|---|
| GET / POST | `/members/{memberId}/certifications` | Cognito / Cognito(admin) |
| GET | `/certifications/expiring` (configurable lead time) | Cognito(admin) |
| GET | `/events` | Cognito |
| POST | `/events/{eventId}/signup` | Cognito |
| GET | `/hours` | Cognito |
| GET | `/reports/iso` | Cognito(admin) |
| GET | `/members/{memberId}/transcript` | Cognito |

## Data Ownership
On the shared `platform-service` table:
- `CERTIFICATION` — `sk=CERT#{certId}`, `status: CURRENT|EXPIRED|REVOKED`, `attachmentS3Key`, GSI2 due-date bucketing for expiry alerting.
- `TRAINING_EVENT` — `sk=METADATA`, GSI3 department-wide list.
- `TRAINING_ATTENDANCE` — `sk=ATTENDEE#{memberId}`, `category` denormalized for ISO rollups.

## Events Produced
- `cert.expiry.due` (daily scheduled Certification Expiry Scanner) → `notification-service`. `{memberId, certId, expiryDate, leadDays}`.

## Events Consumed
None specific.

## Dependencies
- **Internal**: `personnel-service` (`MEMBER_QUALIFICATION.grantedByCertId` currency link, F3.7), `notification-service` (expiry notification delivery).
- **External**: none named.

## Gotchas & Constraints
- F3.7: an expired cert flips `MEMBER_QUALIFICATION.currentlyEligible` to false — this eligibility change must propagate to `alerting-service`'s snapshot via the standard `personnel.eligibility.changed` event, never a direct read.
- No P0/life-safety weight on this service — Tier 2 test tier throughout.

## Source Sections
- Backend §1.1 Bounded contexts (service #6), lines 118-142
- API endpoints, training-service, lines 359-370
- Data Model §3.3 CERTIFICATION, TRAINING_EVENT, TRAINING_ATTENDANCE, lines 914-1027
- Eventing §3, 4.2 (cert.expiry.due), lines 1520-1544, 1666-1698
- Testing §2 F3 matrix, lines 2118-2129
