# personnel-service

## Purpose & Boundaries
Roster, qualifications, attendance, LOSAP points, availability, duty shifts, open-shift signup. Wave 1. Data lives on the shared `platform-service` table. The authoritative source for member eligibility/roster/availability data that `alerting-service` denormalizes into its own `MEMBER_ELIGIBILITY_SNAPSHOT` — this service never serves a synchronous read on the alert hot path.

## Interfaces
Base path `/api/v1/personnel/...`.

| Method | Path | Description | Auth |
|---|---|---|---|
| GET | `/members` | List roster (F2.1) | Cognito |
| POST | `/members` | Create member | Cognito(admin) |
| GET | `/members/{memberId}` | Member detail | Cognito |
| PUT | `/members/{memberId}` | Update member / self-service profile (F2.6) | Cognito |
| PUT | `/members/{memberId}/status` | Status change: active/probationary/LOA/retired | Cognito(admin) |
| GET | `/members/{memberId}/quals` | Qualifications held (F2.2) | Cognito |
| PUT | `/members/{memberId}/quals` | Update quals | Cognito(admin) |
| POST | `/attendance` | Record attendance: call/drill/meeting/detail/standby (F2.3) | Cognito |
| GET | `/members/{memberId}/losap` | LOSAP running total (F2.4) | Cognito |
| GET | `/losap/year-end` | Year-end LOSAP report | Cognito(admin) |
| POST | `/members/{memberId}/availability` | Mark unavailable / return (F2.5) | Cognito |
| GET | `/shifts` | List duty shifts (F2.8) | Cognito |
| POST | `/shifts` | Define a shift with required positions/quals | Cognito(admin) |
| POST | `/shifts/{shiftId}/claim` | Atomic open-shift claim, no double-booking (F2.9) | Cognito |
| POST | `/shifts/{shiftId}/release` | Give back a claimed shift (F2.11) | Cognito |
| POST | `/shifts/{shiftId}/swap` | Propose a swap, officer-approval gated | Cognito |
| GET | `/shifts/coverage` | Coverage view: covered/short/qual-gapped (F2.10) | Cognito(admin) |

## Data Ownership
On the shared `platform-service` table.

- **MEMBER** — `pk=DEPT#{deptId}#MEMBER#{memberId}`, `sk=METADATA`. `status` ACTIVE|PROBATIONARY|LOA|RETIRED, `roles[]` MEMBER|OFFICER|TRAINING|APPARATUS|ADMIN|CHIEF.
- **MEMBER_QUALIFICATION** — `sk=QUAL#{qualCode}`. `grantedByCertId` FK to `CERTIFICATION` (training-service); `currentlyEligible` derived false if granting cert expired.
- **ATTENDANCE_RECORD** — `sk=ATTENDANCE#{occurredAt}`. `activityType` CALL|DRILL|MEETING|WORK_DETAIL|STANDBY; `losapPointsAwarded`.
- **LOSAP_POINT_ENTRY** — `sk=LOSAP#{year}#{entryId}`. `ruleVersionId` ties to the F2.4-configurable points-per-activity rule in effect.
- **AVAILABILITY_MARKOFF** — `sk=MARKOFF#{startAt}`. `affectsAlerting: Boolean` — **event-propagated into the alerting snapshot, never read cross-service at fan-out time** (a note on this entity elsewhere in the source document describing it as "read by alerting-service at fan-out time" is superseded by the reconciled isolation invariant).
- **DUTY_SHIFT** — `pk=DEPT#{deptId}#SHIFT#{shiftId}`, `sk=METADATA`. `status` OPEN|PARTIALLY_FILLED|FULL|CANCELLED.
- **SHIFT_POSITION** — `sk=POSITION#{positionCode}`. `claimedByMemberId` absent until claimed — atomic claim via `UpdateItem` with `ConditionExpression attribute_not_exists(claimedByMemberId)`, no lock table or transaction needed.
- **SHIFT_SWAP_REQUEST** — `sk=SWAP#{requestedAt}`. `status` PENDING|APPROVED|DENIED, `requiresOfficerApproval` per F2.11.

GSI1 (`MEMBER#{memberId}`) serves every "my X" self-service read. GSI3 (`DEPT#{deptId}#DUTY_SHIFT`) serves open-shift browsing.

## Events Produced
- `personnel.member.updated`, `personnel.eligibility.changed`, `personnel.availability.changed` — outbox pattern, consumed by `alerting-service` to maintain `MEMBER_ELIGIBILITY_SNAPSHOT`. This is the trigger for Cognito refresh-token revocation on status change (LOA/retired).
- `personnel.attendance.recorded` — `{memberId, activityType, activityId, losapPoints}` — outbox, consumed by LOSAP Accrual handler (internal to this service) and Reporting Projections (`reporting-service`).
- `scheduling.coverage_gap.detected` (Shift Coverage Scanner, scheduled) — routed to `notification-service`.

## Events Consumed
None named in the source document for this service specifically (it is a producer for the eligibility/roster propagation chain).

## Dependencies
**Internal:** publishes to `alerting-service` (eligibility snapshot maintenance, event-driven only — never a synchronous call); publishes to `reporting-service` (Reporting Projections rollups) and `notification-service` (coverage-gap routing); `training-service` is the source of `CERTIFICATION` records that `MEMBER_QUALIFICATION.grantedByCertId` references.
**External:** none.

## Gotchas & Constraints
- **Shift claim atomicity (F2.9) depends on reading current DynamoDB state directly — `SHIFT_POSITION` claim state is explicitly never cached.** The `ConditionExpression attribute_not_exists(claimedByMemberId)` pattern is the entire no-double-booking mechanism; do not introduce a lock table.
- **`AVAILABILITY_MARKOFF.affectsAlerting` must be event-propagated, not cross-service-read.** This is a corrected/reconciled point in the source document — an earlier description of a direct alerting-service read of this field is explicitly wrong and superseded.
- Offline shift claims (mobile): a claim made offline is queued as **pending**, never shown as confirmed, until the server round-trip confirms or rejects it — this is the one workflow the frontend domain calls out as genuinely contended under offline-optimism.
- LOSAP year-end report (F8.2) is app-side aggregation over per-member GSI1 queries (small roster) — not a dedicated rollup store.
- CT LOSAP statutory point rules are unresolved (OQ-12/OQ-19) — `LOSAP_POINT_ENTRY`/`DEPARTMENT_CONFIG#LOSAP_POINT_RULES` are modeled generically to absorb whatever the statute requires; actual rule content is not yet specified.
- Concurrent shift-claim race is a required integration test against real DynamoDB conditional writes (Tier 1).

## Source Sections
- Backend §1.1 Bounded contexts / service table — lines 116–142
- API endpoints: personnel-service — lines 283–303
- Data Model §3.3 MEMBER, MEMBER_QUALIFICATION, ATTENDANCE_RECORD, LOSAP_POINT_ENTRY, AVAILABILITY_MARKOFF, DUTY_SHIFT, SHIFT_POSITION, SHIFT_SWAP_REQUEST — lines 780–900
- Data Model §4 Access patterns #10, #12, #14–22 — lines 1191–1204
- Backend §1.3 Alerting isolation invariant (eligibility snapshot maintenance) — lines 205–219
- Events §5 Producer/consumer table (`personnel.attendance.recorded`, `scheduling.coverage_gap.detected`) — lines 1503–1522
- Frontend §9 Offline and sync (shift-claim pending state) — lines 1779–1787
- Testing §2 F2 test matrix — lines 1907–1922
