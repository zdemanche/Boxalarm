# personnel-service

## Purpose & Boundaries

Roster, qualifications, attendance, LOSAP points, availability, duty shifts, open-shift signup. Service 3 of 10, Wave 1. Logical service; physical table is the shared `platform-service` table.

## Interfaces

Base path `/api/v1/personnel/...`.

| Method | Path | Description | Auth |
|---|---|---|---|
| GET | `/members` | List roster (F2.1) | Cognito |
| POST | `/members` | Create member | Cognito(admin) |
| GET | `/members/{memberId}` | Member detail | Cognito |
| PUT | `/members/{memberId}` | Update / self-service profile (F2.6) | Cognito |
| PUT | `/members/{memberId}/status` | Status change: active/probationary/LOA/retired | Cognito(admin) |
| GET \| PUT | `/members/{memberId}/quals` | Qualifications held / update (F2.2) | Cognito / Cognito(admin) |
| POST | `/attendance` | Record attendance: call/drill/meeting/detail/standby (F2.3) | Cognito |
| GET | `/members/{memberId}/losap` | LOSAP running point total (F2.4, per-member only — year-end aggregate is reporting-service's) | Cognito |
| POST | `/members/{memberId}/availability` | Mark unavailable / return (F2.5) | Cognito |
| GET | `/shifts` | List duty shifts (F2.8) | Cognito |
| POST | `/shifts` | Define shift w/ required positions/quals | Cognito(admin) |
| POST | `/shifts/{shiftId}/claim` | Atomic open-shift claim, no double-booking (F2.9) | Cognito |
| POST | `/shifts/{shiftId}/release` | Release a claimed shift (F2.11) | Cognito |
| POST | `/shifts/{shiftId}/swap` | Propose swap, officer-approval gated | Cognito |
| GET | `/shifts/coverage` | Coverage view: covered/short/qual-gapped (F2.10) | Cognito(admin) |
| GET | `/health/liveness` \| `/health/readiness` | Health | none |

## Data Ownership

On `platform-service` physical table.

- **MEMBER** — `pk=DEPT#{deptId}#MEMBER#{memberId}`, `sk=METADATA`. `firstName`/`lastName`/`phone`/`email`/`agencyId` **PII**. `roles`: `MEMBER`|`OFFICER`|`TRAINING`|`APPARATUS`|`ADMIN`|`CHIEF`.
- **MEMBER_QUALIFICATION** — `sk=QUAL#{qualCode}`. `currentlyEligible` derived (false if granting cert expired).
- **ATTENDANCE_RECORD** — `sk=ATTENDANCE#{occurredAt}`. `activityType`, `refId`, `hours`, `losapPointsAwarded`.
- **LOSAP_POINT_ENTRY** — `sk=LOSAP#{year}#{entryId}`. `points`, `sourceRefId`, `ruleVersionId`.
- **AVAILABILITY_MARKOFF** — `sk=MARKOFF#{startAt}`. `affectsAlerting` boolean — **event-propagated into `MEMBER_ELIGIBILITY_SNAPSHOT.availabilityState` only, never read cross-service at fan-out time.**
- **DUTY_SHIFT** — `pk=DEPT#{deptId}#SHIFT#{shiftId}`, `sk=METADATA`.
- **SHIFT_POSITION** — `sk=POSITION#{positionCode}`. `claimedByMemberId` absent until claimed; claim is `UpdateItem` with `ConditionExpression attribute_not_exists(claimedByMemberId)` — atomic no-double-booking without a lock table.
- **SHIFT_SWAP_REQUEST** — `sk=SWAP#{requestedAt}`. `requiresOfficerApproval`.

## Events Produced

- `personnel.member.updated`, `personnel.eligibility.changed`, `personnel.availability.changed` — outbox pattern, for eligibility-affecting changes. **Consumed by alerting-service to maintain `MEMBER_ELIGIBILITY_SNAPSHOT`.**
- `personnel.attendance.recorded` — outbox. Consumers: LOSAP Accrual Service (handler within personnel-service itself), Reporting Projections (handler within reporting-service).

## Events Consumed

None named directly.

## Dependencies

**Internal:** `alerting-service` (one-way, event-driven only — personnel-service never reads or is read by alerting-service synchronously). `reporting-service` reads this service's data via GSIs on the shared table (no API call).

**External:** none named.

## Gotchas & Constraints

- **`AVAILABILITY_MARKOFF.affectsAlerting` is event-propagated, never read cross-service at fan-out time** — a prior version of this document incorrectly described a direct read; alerting-service's execution role holds no permission on this table at all, so such a read would fail closed at runtime regardless.
- **Shift claim atomicity depends on reading current DynamoDB state directly — never cached.** `SHIFT_POSITION` claim state is explicitly on the "never cached" list.
- **LOSAP year-end reporting is NOT owned here** — `/api/v1/personnel/losap/year-end` was a duplicate of `reporting-service`'s `/api/v1/reporting/losap/year-end` and was removed (N-3, decided). This service keeps only the per-member running total.
- **CT LOSAP statutory point rules are unresolved (OQ-12)** — `LOSAP_POINT_ENTRY`/`DEPARTMENT_CONFIG#LOSAP_POINT_RULES` modeled generically (configurable rule set) to absorb whatever the statute requires; actual rule content not yet specified.

## Source Sections

- Backend §1.1 Service inventory (`:120-146`)
- Backend §2 personnel-service API endpoints (`:312-333`)
- Data Model §3.3 MEMBER, MEMBER_QUALIFICATION, ATTENDANCE_RECORD, LOSAP_POINT_ENTRY, AVAILABILITY_MARKOFF, DUTY_SHIFT, SHIFT_POSITION, SHIFT_SWAP_REQUEST (`:937-1058`)
- Data Model §4 Access patterns 10, 11b-22 (`:1376-1389`)
- Events §Other domains, producer/consumer table (personnel.* events) (`:1787-1817`)
- Open Questions OQ-12 CT LOSAP statutory rules (`:2711`)
