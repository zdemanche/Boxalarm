# Personnel Service

## Purpose & Boundaries
Roster, member status, qualifications, attendance (call/drill/meeting/work detail/standby), LOSAP points (configurable rules; benefit engine configurable with a `TRUMBULL_12_81W` template — thresholds entered by dept, never assumed), availability mark-offs, duty shifts, atomic open-shift claims, swaps, coverage. Sole writer of member push-device list (`writePushDevices`). LOSAP Accrual is a handler here. Shares `platform` table.

## Interfaces
GET/POST `/api/v1/personnel/members`; GET/PUT `/members/{memberId}` (self edit may NEVER change email — admin-managed recovery address; CHIEF/ADMIN only; CHIEF/ADMIN target's email changeable only by ADMIN); PUT `/members/{memberId}/status` (CHIEF/ADMIN; only CHIEF/ADMIN may change a CHIEF/ADMIN's status; every LOA/RETIRED alarms chief); GET/PUT `/members/{memberId}/quals`; POST `/attendance`; GET `/members/{memberId}/losap`; POST/GET `/members/{memberId}/availability` (cap 90 days -> 400; replayed create same `startAt` -> 409; GET returns `{markOffs:[{markoffId,startAt,endAt,reason?}]}` epoch seconds, own: `ViewOwnAvailability`, anyone's: officer `ViewMemberAvailability`); POST `/members/{memberId}/availability/{markoffId}/end` (`markoffId` = stored `startAt`; repeat -> 200 `alreadyEnded: true`; own `EndOwnMarkoff`, anyone's officer `EndMemberMarkoff`); GET/POST `/shifts`; POST `/shifts/{shiftId}/claim|release|swap`; GET `/shifts/coverage` (admin); health pair. Per-member LOSAP total only here; year-end report belongs to reporting-service.

## Data Ownership
MEMBER `pk=DEPT#{deptId}#MEMBER#{memberId}` `sk=METADATA` (status ACTIVE|PROBATIONARY|LOA|RETIRED; roles MEMBER|OFFICER|TRAINING|APPARATUS|ADMIN|CHIEF; PII: firstName,lastName,phone,email,agencyId); MEMBER_QUALIFICATION `sk=QUAL#{qualCode}`; ATTENDANCE_RECORD `sk=ATTENDANCE#{occurredAt}`; LOSAP_POINT_ENTRY `sk=LOSAP#{year}#{entryId}` (ruleVersionId); AVAILABILITY_MARKOFF `sk=MARKOFF#{startAt}` (ending keeps the row; sets endAt/revertedAt/endedAt/endedBy; upcoming cancel: `endAt = startAt`, `cancelled: true`); DUTY_SHIFT `pk=DEPT#{deptId}#SHIFT#{shiftId}` `sk=METADATA` (status OPEN|PARTIALLY_FILLED|FULL|CANCELLED; gsi3 `DEPT#{deptId}#DUTY_SHIFT`/`{startAt}`); SHIFT_POSITION `sk=POSITION#{positionCode}` (`claimedByMemberId` absent until claimed); SHIFT_SWAP_REQUEST `sk=SWAP#{requestedAt}` (PENDING|APPROVED|DENIED; `requiresOfficerApproval`). GSI1 for "my X". Access patterns 10, 12, 14-15, 17-22.

## Events Produced
`personnel.member.updated` (PII), `personnel.eligibility.changed`, `personnel.availability.changed` (`AVAILABLE` emitted on early end), `personnel.attendance.recorded` (`{memberId, activityType, activityId, losapPoints}`; outbox). All through outbox -> platform bus; platform drain previously dropped mark-offs (now wired).

## Events Consumed
`personnel.attendance.recorded` (LOSAP Accrual handler, via `losap-accrual-queue`+DLQ); shift attendance -> LOSAP (F2.12).

## Dependencies
internal: platform-service (config, session consumer), alerting-service (snapshot consumer), reporting-service. external: Cognito (via platform consumer), EventBridge.

## Gotchas & Constraints
- Status->paging mapping: PROBATIONARY IS paged; non-paged set exactly `{LOA, RETIRED}` (`NON_PAGED_STATUSES`) pinned equal to session revocation `REVOKING_STATUSES`. `createMember` makes PROBATIONARY; snapshot seeds them active. RETIRED left only by reinstatement to ACTIVE (CHIEF/ADMIN); retired never moves to LOA; reinstatement restores paging and re-enables login via `personnel.member.updated` chain.
- Shift claim = `UpdateItem` with `ConditionExpression attribute_not_exists(claimedByMemberId)` — no lock table; offline claim shows pending until server confirms.
- Mark-off ending: deletes both schedules; a firing schedule finds `revertedAt` and no-ops; overlapping windows over-page (safe direction); racing ACTIVATE ordered by snapshot clock; audit entry written.
- Push-device writes: write guarded on member row `updatedAt`, newest 10 entries, release other member's entry on exact token match; every write via `writePushDevices` so snapshot hears it.
- Email change writes revocation marker `LOGIN_EMAIL_CHANGE`, signs out everywhere, emails old address, alarm `MemberEmailChanged`; no step-up.
- Tightening status route to ADMIN-for-protected-targets is an open hardening item.
- CT LOSAP statutory rules unknown (OQ-12); modeled generically.

## Source Sections
Backend §1.1 (122-150); §2 personnel-service (375-398); Data Model MEMBER..SHIFT_SWAP (1022-1145); AVAILABILITY_MARKOFF amendment (1096-1107); access patterns (1466-1479); Events §4.2/§5 personnel.attendance (1887, 1909); Security email recovery (2741)
