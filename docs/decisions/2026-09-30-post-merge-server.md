# 2026-09-30: Post-merge server fixes (fix/post-merge-server)

**Scope:** decisions and accepted residuals from the post-merge reviews:
- `.analysis/post-merge/paging-chain.md`
- `.analysis/post-merge/security-web.md`
- `.analysis/post-merge/server-fix-review-security.md`
- `.analysis/post-merge/server-fix-review-paging.md`

## NERIS entity rows share the department config partition (security review MINOR 3)

**Decision:** 930da73 limits every NERIS entity DynamoDB grant (get, put, sync worker) with `dynamodb:LeadingKeys` to the bare department partition `DEPT#{deptId}`. It excludes `DEPT#*#*`, so member rows, `SESSION_REVOCATION` markers and member outboxes are out of reach. The sync worker's outbox write is a separate `PutItem`-only grant on `DEPT#*#OUTBOX`.

**Residual, accepted:**
- **The bare `DEPT#{deptId}` partition also holds department configuration.** That covers `CONFIG#ALERT_RULES`, `CONFIG#NERIS` (including the submissions kill switch), and the other `CONFIG#*` rows (`platform-service/config/repository.ts`). IAM cannot scope a sort key: `dynamodb:LeadingKeys` matches the partition key only. So the sync worker, which holds the NERIS client secret and makes outbound calls, can still `PutItem` or `UpdateItem` those config rows.
- **The worker's outbox grant covers any `DEPT#*#OUTBOX` row.** A defect could therefore write a forged event into the platform outbox. That includes a `personnel.member.updated`, because the platform drain republishes each row under its own `source`.
- **Why not fix it now:** closing the gap means moving the entity row to its own partition, `DEPT#{deptId}#NERIS_ENTITY` with sk `METADATA`. That needs a data migration of the existing `NERIS#ENTITY` row plus reader changes in `getEntity`, `putEntity`, `syncWorker` and `entitySync`. That is a separate change with its own rollout, not a review fix.
- **What the current scoping already buys:** the worker can no longer touch member rows, revocation markers or member push devices directly. Those were the escalation paths `security-web.md` named.

**Revisit when** NERIS entity sync next changes, or if the platform drain gains a per-source event-type allow-list. With that allow-list, the forged-outbox path closes at the drain.

## NERIS submit is the officer tier (security review MINOR 4)

**Decision: kept as shipped in 6f655a4.** `SubmitIncidentReport` is in the NERIS officer tier (OFFICER/CHIEF/ADMIN), the same as `LockIncidentReport` and `ResubmitIncidentReport`.
- The officer who reviews and locks a report already may resubmit a correction to NERIS. Refusing the first send made no sense.
- It matches the PRD's flow, in which the officer completes and files the report (F7).
- The web Submit button follows the same rule (`canSubmitIncident`).
- A report still cannot be sent until an officer has locked it, and the department kill switch (`CONFIG#NERIS submissionsEnabled`) still applies.

## Member email is the recovery address (security review MAJOR 1)

**Decision:**
- An email change is written to Cognito as verified, following the admin-attested provisioning model. That makes it a takeover lever, so it is guarded like the kill switches:
  - **Chief/admin only.** Only a CHIEF or ADMIN may change a member's email. A member's own edit may never change it.
  - **Protected targets need an admin.** A CHIEF or ADMIN target's email may be changed only by an ADMIN.
  - **Every change ends the member's sessions.** It writes the revocation marker (`LOGIN_EMAIL_CHANGE`) and does a global sign-out.
  - **Every change emails the previous address**, naming the new address and the actor. This is best effort.
  - **Every change alarms the chief** (`MemberEmailChanged`).
- There is no step-up or confirmation code: this is the settled no-step-up decision. The notice and the alarm are the detective controls.

**Residual, accepted:** a compromised ADMIN account can still redirect any member's recovery address. The previous address and the chief both hear of it at once.

## Mark-offs really unpage now, so they can be listed, ended early and are capped (paging review MAJOR-A)

**Why:** before e45e3d9 the platform drain dropped every mark-off, so a mark-off never reached alerting. Now one really stops a member's call alerts, until its `endAt`. There was no way back, and `endAt` could run to the year 2100.

**Decision: API contract.** Web uses it now; the mobile "I'm available again" button is being built against it on the mobile branch.
- **List:** `GET /api/v1/personnel/members/{memberId}/availability` returns `{ markOffs: [{ markoffId, startAt, endAt, reason? }] }`.
  - Times are in epoch seconds.
  - It returns current and upcoming mark-offs only; ended, cancelled and past ones are left out.
  - `markoffId` is the stored `startAt` as a string, because rows are `MARKOFF#{startAt}`.
- **End:** `POST /api/v1/personnel/members/{memberId}/availability/{markoffId}/end` returns `{ markoffId, endedAt, cancelled }`.
  - A current mark-off ends now. An upcoming one is cancelled.
  - A repeat call answers `200` with `alreadyEnded: true`.
- **Who may call them:**
  - the member, on their own record (`ViewOwnAvailability`, `EndOwnMarkoff`, every role);
  - an OFFICER, CHIEF or ADMIN, on anyone's record (`ViewMemberAvailability`, `EndMemberMarkoff`).
- **What ending does:**
  - It keeps the `MARKOFF#` row. It sets `endAt` to now (for an upcoming mark-off, `endAt = startAt` and `cancelled: true`), plus `revertedAt`, `endedAt` and `endedBy`. Because the row stays, a replayed create for the same `startAt` still gets `409` and cannot unpage the member again (mobile review R3-M2).
  - It emits `personnel.availability.changed AVAILABLE` through the outbox, even for an upcoming mark-off: an `ACTIVATE` racing the end is ordered by the snapshot clock.
  - It writes an audit entry.
  - It deletes both schedules, ignoring not-found errors. A schedule that fires anyway finds `revertedAt` and does nothing.
- **Cap:** a mark-off may last at most 90 days (`400` otherwise). A longer absence is LOA, a status change.

**Before deploy (ops):** mark-offs created before this change never reached alerting. Their pending `ACTIVATE` schedules will now unpage those members. List `MARKOFF#` rows with a future `endAt` and confirm them with the members, or end them with the route above.

**Residual:** overlapping windows. The first window's `REVERT`, or ending it early, emits `AVAILABLE` while a second window is still active. That over-pages the member, which is the safe direction.
