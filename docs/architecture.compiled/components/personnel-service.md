# Personnel Service

## Purpose & Boundaries
Roster (F2.1), self-service profile (F2.6), status, quals (F2.2), attendance (F2.3), LOSAP running totals (F2.4; benefit engine configurable with `TRUMBULL_12_81W` template, thresholds entered by dept), availability mark-offs (F2.5), duty shifts/claim/release/swap/coverage (F2.8–F2.11), shift attendance -> LOSAP (F2.12). Roles: `MEMBER|OFFICER|TRAINING|APPARATUS|ADMIN|CHIEF` (F2.7). Single push-device writer: `writePushDevices`.

## Interfaces
`/api/v1/personnel`: GET/POST `/members`; GET/PUT `/members/{memberId}` (own edit may NEVER change email); PUT `/members/{memberId}/status` (admin; only CHIEF/ADMIN may change CHIEF/ADMIN status; LOA/RETIRED alarm chief); GET/PUT `/members/{memberId}/quals`; POST `/attendance`; GET `/members/{memberId}/losap`; POST/GET `/members/{memberId}/availability` (cap 90 days -> 400; replay same `startAt` -> 409; list = `{markOffs:[{markoffId,startAt,endAt,reason?}]}` epoch seconds; Cedar `ViewOwnAvailability`/`ViewMemberAvailability`); POST `/members/{memberId}/availability/{markoffId}/end` (`EndOwnMarkoff`/`EndMemberMarkoff`; repeat -> 200 `alreadyEnded: true`); GET/POST `/shifts`; POST `/shifts/{shiftId}/claim|release|swap`; GET `/shifts/coverage` (admin); health pair. LOSAP year-end endpoint belongs to reporting-service (removed here, N-3).

## Data Ownership
Platform table, `pk=DEPT#{deptId}#MEMBER#{memberId}`: `MEMBER` (sk METADATA; status ACTIVE|PROBATIONARY|LOA|RETIRED; roles list; PII firstName/lastName/phone/email/agencyId), `MEMBER_QUALIFICATION` (`QUAL#{qualCode}`, grantedByCertId, currentlyEligible), `ATTENDANCE_RECORD` (`ATTENDANCE#{occurredAt}`; activityType CALL|DRILL|MEETING|WORK_DETAIL|STANDBY), `LOSAP_POINT_ENTRY` (`LOSAP#{year}#{entryId}`, ruleVersionId), `AVAILABILITY_MARKOFF` (`MARKOFF#{startAt}`, affectsAlerting, endAt/revertedAt/endedBy/cancelled). Shifts `pk=DEPT#{d}#SHIFT#{shiftId}`: `DUTY_SHIFT` (METADATA; status OPEN|PARTIALLY_FILLED|FULL|CANCELLED; gsi3 `DEPT#{d}#DUTY_SHIFT`/`{startAt}`), `SHIFT_POSITION` (`POSITION#{code}`; `claimedByMemberId` absent until claimed), `SHIFT_SWAP_REQUEST` (`SWAP#{requestedAt}`; PENDING|APPROVED|DENIED). GSI1 `MEMBER#{memberId}`; member roster list GSI3 `DEPT#{d}#MEMBER`.

## Events Produced
`personnel.member.updated` (PII), `personnel.eligibility.changed`, `personnel.availability.changed` (AVAILABLE/MARKED_OFF/LOA via outbox; ACTIVATE ordered by snapshot clock), `personnel.attendance.recorded` `{memberId, activityType, activityId, losapPoints}` (outbox), `scheduling.coverage_gap.detected` (shift coverage scanner; domain left as `scheduling`).

## Events Consumed
`personnel.attendance.recorded` (LOSAP Accrual handler, in this service).

## Dependencies
internal: alerting-service (snapshot consumer), platform-service (session revocation consumer), notification-service. external: DynamoDB, EventBridge.

## Gotchas & Constraints
- Status->paging mapping: PROBATIONARY IS paged; non-paged set exactly `{LOA, RETIRED}` (`NON_PAGED_STATUSES`) pinned equal to `REVOKING_STATUSES`. RETIRED left only by reinstatement to ACTIVE (CHIEF/ADMIN); retired never moves to LOA.
- Shift claim: `UpdateItem` `ConditionExpression attribute_not_exists(claimedByMemberId)` — atomic, no lock table; never cached; offline claims show pending in UI.
- Attendance + LOSAP written in one `TransactWriteItems` (AP 15).
- Ending a mark-off keeps the row; emits AVAILABLE; deletes both schedules; overlapping windows over-page (safe direction).
- `writePushDevices` is the only mutator of push-device list; registration keeps newest 10 entries, guarded on member row `updatedAt`; releases another member's entry only on exact token match.
- CT LOSAP statutory rules unread (OQ-12) — rules generic/configurable.

## Source Sections
§1.1 122–150; §1.4 outbox 285–291; §2 personnel API 375–398; Data Model §3.3 MEMBER..SHIFT_SWAP 1022–1145; AVAILABILITY amendment 1107; AP 10–22 1466–1479; Testing F2 2316–2331.
