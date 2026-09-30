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
