# personnel-service

## Purpose & Boundaries
Roster, qualifications, attendance, LOSAP points, availability, duty shifts, and open-shift signup. Publishes the eligibility/roster events `alerting-service` denormalizes into its own snapshot — this service never blocks or is called synchronously by the alert hot path (N1.5).

## Interfaces
Base path `/api/v1/personnel/...`.

| Method | Path | Auth |
|---|---|---|
| GET / POST | `/members` | Cognito / Cognito(admin) |
| GET / PUT | `/members/{memberId}` | Cognito |
| PUT | `/members/{memberId}/status` | Cognito(admin) |
| GET / PUT | `/members/{memberId}/quals` | Cognito / Cognito(admin) |
| POST | `/attendance` | Cognito |
| GET | `/members/{memberId}/losap` | Cognito |
| GET | `/losap/year-end` | Cognito(admin) |
| POST | `/members/{memberId}/availability` | Cognito |
| GET / POST | `/shifts` | Cognito / Cognito(admin) |
| POST | `/shifts/{shiftId}/claim` (atomic, no double-booking) | Cognito |
| POST | `/shifts/{shiftId}/release` | Cognito |
| POST | `/shifts/{shiftId}/swap` | Cognito |
| GET | `/shifts/coverage` | Cognito(admin) |

## Data Ownership
On the shared `platform-service` table:
- `MEMBER` — `pk=DEPT#{deptId}#MEMBER#{memberId}`, `sk=METADATA`. `roles: MEMBER|OFFICER|TRAINING|APPARATUS|ADMIN|CHIEF`.
- `MEMBER_QUALIFICATION` — `sk=QUAL#{qualCode}`, `currentlyEligible` derived false if granting cert expired.
- `ATTENDANCE_RECORD` — `sk=ATTENDANCE#{occurredAt}`.
- `LOSAP_POINT_ENTRY` — `sk=LOSAP#{year}#{entryId}`, `ruleVersionId` for configurable points-per-activity.
- `AVAILABILITY_MARKOFF` — `sk=MARKOFF#{startAt}`, `affectsAlerting: Boolean` — event-propagated into the alerting snapshot, never read cross-service by alerting at fan-out time.
- `DUTY_SHIFT` — `sk=METADATA`, `status: OPEN|PARTIALLY_FILLED|FULL|CANCELLED`.
- `SHIFT_POSITION` — `sk=POSITION#{positionCode}`. Claim is `UpdateItem` with `ConditionExpression attribute_not_exists(claimedByMemberId)` — atomic no-double-booking without a lock table.
- `SHIFT_SWAP_REQUEST` — `sk=SWAP#{requestedAt}`.

## Events Produced
- `personnel.member.updated`, `personnel.eligibility.changed`, `personnel.availability.changed` — consumed by `alerting-service` to maintain `MEMBER_ELIGIBILITY_SNAPSHOT`. Outbox pattern.
- `personnel.attendance.recorded` — `{memberId, activityType, activityId, losapPoints}` → LOSAP Accrual + Reporting Projections consumers.
- `scheduling.coverage_gap.detected` (Shift Coverage Scanner, scheduled) → `notification-service`.

## Events Consumed
None on the alert hot path (deliberately — this service is never a synchronous dependency of alerting).

## Dependencies
- **Internal**: `alerting-service` (one-way event consumer of eligibility changes, never the reverse), `notification-service` (coverage-gap notifications), `training-service` (cert-driven qual currency via `MEMBER_QUALIFICATION.grantedByCertId`), `reporting-service` (LOSAP/attendance rollups read GSIs on this table).
- **External**: none named.

## Gotchas & Constraints
- Snapshot staleness (a member added/removed mid-shift) is an accepted, documented tradeoff for keeping alerting's eligibility read denormalized rather than a live cross-service call.
- Shift-claim atomicity (F2.9) depends on reading current DynamoDB state directly — `SHIFT_POSITION` claim state is explicitly never cached.
- CT LOSAP statutory point rules are unresolved (OQ-12) — `LOSAP_POINT_ENTRY`/`DEPARTMENT_CONFIG#LOSAP_POINT_RULES` are modeled generically to absorb whatever the statute requires; actual rule content not yet specified.

## Source Sections
- Backend §1.1 Bounded contexts (service #3), lines 118-142
- API endpoints, personnel-service, lines 306-327
- Data Model §3.3 MEMBER through SHIFT_SWAP_REQUEST, lines 884-1005
- Data Model §4 Access patterns 10, 11b-22, lines 1302-1315
- Eventing §3-5 (personnel/attendance flow), lines 1520-1544, 1676-1698
