# ELIG-INFRA: Wire the alerting-plane eligibility, availability, and member-snapshot consumers plus the shift-completion schedule

**Key:** ELIG-INFRA
**Story:** E2-S2/E3-S8/E2-S5/E2-S6/E2-S11 infrastructure children + bug #114
**Directory:** `infrastructure/`
**Issues:** #114, #204, #221, #207, #208, #213

**Life-safety.** The backend consumers for these events all exist on main, but the event → queue → consumer wiring was never deployed, so today (a) an expired certification never updates alerting eligibility, (b) a member who marks off is still paged, (c) a contact-channel change never reaches the alerting snapshot. `addQueueConsumer` is currently called only once in the repo (session revocation). This run deploys: `personnel.eligibility.changed` → eligibility-snapshot queue → `backend/src/services/alerting-service/eligibility/eligibilityChangedConsumer.ts`; the platform-table stream → `personnel-service/events/certExpiredReactor.ts` if not already wired; `personnel.availability.changed` → availability-snapshot queue → `alerting-service/eligibility/consumer.ts`; `personnel.member.updated` → member-snapshot queue → `alerting-service/eligibility/memberUpdatedHandler.ts` (a **separate** queue from session revocation's, which E8-S8-INFRA owns — do not reuse it); and the EventBridge Scheduler job for `personnel-service/shifts/completionHandler.ts` (#213) with DLQ + alarm. Alerting-side consumers run under the alerting-service role and gain only alerting-table permissions; no LOB role gains any. For #221, the staging end-to-end propagation check is not runnable here — deliver its IAM-isolation guarantee as a Vitest policy assertion over the rendered role documents, and state the 30-second propagation check as a residual. Verify each handler's actual event names and payload shapes by reading the handler and its producer before wiring — trace producer → rule pattern → queue → consumer end to end as one chain.

## Standing notes (apply to every issue below)

- **Monorepo.** Repo root is `/Users/zacharydemanche/Projects/boxalarm`. This run touches **only `infrastructure/`** (plus tests inside it). Sibling bundle runs own the other directories; do not edit them.
- **The issues' "Current state" sections are stale** — they were written before ~30 batch PRs merged. Verify everything against the code on `main`; reuse what exists, never duplicate it.
- **Wording constraint for the plan document.** A mechanical plan gate greps for the literal string `caller-supplied` (and `caller supplies`) and fails the plan on a match, even inside a sentence that denies it. Never use those phrases. Say "derived server-side from the verified token" / "originates from the authenticated principal" instead. This changes nothing about the design.
- **Alerting invariants** (life-safety, non-negotiable): alerting plane is SNS FIFO; routing and dedup key on `channel` (never `channelTier`); exactly-once key `{dispatchId}#{toneSequence}#{memberId}#{channel}`; alerting isolation is an **IAM boundary** — no LOB role gains any alerting-table permission, and alerting Lambdas stay out of any VPC; `{deptId}` is in every partition key.
- Auth is settled: no MFA, no step-up, no session timeout. Do not add any.
- One PR closes every issue listed below; list them as `Closes #n` in the PR body.
- **Reuse the existing infra patterns exactly** — read these first: `infrastructure/components/training/*.ts` and `infrastructure/components/incident/incident.ts` (route + arm64 Lambda + least-privilege role per handler, `lambdaCode(service, fn)` from `backend/scripts/lambda-manifest.mjs`), `infrastructure/components/messaging/queue-consumer.ts` (`QueueConsumer`/`addQueueConsumer`: queue + DLQ + alarm), `infrastructure/components/messaging/outbox-publisher.ts`, `infrastructure/components/api/http-api.ts`, and `infrastructure/index.ts` wiring. Add any new backend handler entries to `backend/scripts/lambda-manifest.mjs` ONLY if that file is the manifest the infra reads — if so, that single-file edit in `backend/` is permitted.
- **U.S. residency gate:** `infrastructure/test/residency-encryption.test.ts` fails any global-edge resource. **Do not provision CloudFront.** Where an issue says CloudFront signed URLs, use region-pinned S3 presigned URLs from the handler instead (the pattern `infrastructure/components/training/certifications.ts` documents at lines ~32-39).
- DynamoDB index names are case-sensitive; the platform table defines the spelling. If a backend handler queries a differently-cased index name, report it in the plan as a residual rather than editing `backend/`.
- Tests: Vitest assertions over the Pulumi resource graph, in the style of the existing `infrastructure/test/*.test.ts` — routes exist with the authorizer, each role grants only the listed actions/resources, queues have DLQ + alarm.


---

# Issues in this bundle

## #114 — No alerting-service consumer for personnel.eligibility.changed — expired certs never update alerting eligibility

Nothing under `src/services/alerting-service` consumes `personnel.eligibility.changed`. E2-S2 AC4 and E3-S8 require an expired/revoked qualification to propagate into the alerting eligibility snapshot; today the snapshot never changes, so alert audience selection runs on stale eligibility.

Read boxalarm-docs#11 before touching the alert path. Infra side: boxalarm-infrastructure#47 (E3-S8-INFRA), zdemanche/boxalarm-backend#30 (E2-S2-INFRA).


---

## #204 — E2-S2-INFRA: Qualifications and quals-based eligibility

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/43 · **Wave:** 4

This repo deploys the quals endpoints and the cert-expired → eligibility-changed → alerting snapshot chain.

## Scope
- HTTP API routes: `GET /api/v1/personnel/members/{memberId}/quals` → `quals/handler.ts#getQualsHandler`; `PUT .../quals` → `#putQualsHandler`. IAM: platform table read/write, `verifiedpermissions:IsAuthorizedWithToken`.
- `platform-service` table stream → `events/certExpiredReactor.ts` (filter `entityType = CERTIFICATION`), with partial batch failure reporting on, on-failure destination + alarm on `Boxalarm/PersonnelService EligibilityFlipFailed`.
- Same stream → `events/outboxPublisher.ts` (filter `entityType = OUTBOX`; this is a different outbox shape from OUTBOX_ENTRY) → `events:PutEvents` on `boxalarm-{env}-platform-bus`.
- Bus rule `detail-type = personnel.eligibility.changed` → `boxalarm-{env}-eligibility-changed-snapshot-queue` + DLQ (`maxReceiveCount: 5`, DLQ depth alarm paging on-call) → alerting-service eligibility consumer Lambda.
- Alerting consumer role: read/write **only** the `alerting-service` table (IAM boundary); not VPC-attached.

## Acceptance criteria
1. Given a CERTIFICATION item transitions to EXPIRED on the stream, when the reactor runs, then `currentlyEligible` flips and one `personnel.eligibility.changed` reaches the bus (AC2).
2. Given that event, when it is routed, then it lands on the eligibility snapshot queue and the consumer updates `MEMBER_ELIGIBILITY_SNAPSHOT.quals` within 30s p99 (AC4).
3. Given the alerting consumer role, when IAM is simulated against the `platform-service` table, then every action is denied (AC4, N1.5).
4. Given a poison message, when it fails 5 receives, then it lands in the DLQ and the alarm fires.

## Current state
`boxalarm-infrastructure` at origin/main has only Cognito (`components/identity/*`) and observability (`components/observability/*`) — no API Gateway, DynamoDB table, EventBridge bus, SQS, Scheduler, or service Lambda exists yet.

Backend expects: `PERSONNEL_TABLE_NAME` + `PLATFORM_BUS_NAME` (`awsClients.ts`), `VERIFIED_PERMISSIONS_POLICY_STORE_ID`.

**Backend gap:** no alerting-service handler consumes `personnel.eligibility.changed` at origin/main (`eligibility/consumer.ts` handles only `personnel.availability.changed`; `memberUpdatedHandler.ts`/`maintainMemberSnapshot.ts` handle `personnel.member.updated`). The queue target is blocked until the backend adds or extends a consumer.

## Depends on
- E8-S7 (platform-service table with GSI1–3 + Streams), E8-S1 (HTTP API + shared authorizer route wiring; infrastructure#6 covers only the Cognito claim), E8-S3 (Verified Permissions policy store)
- E2-S1-INFRA (platform bus)
- E3-S1-INFRA (CERTIFICATION writes)




---

## #221 — E3-S8-INFRA: Expired certification revokes qual currency and propagates to alerting eligibility

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/60 · **Wave:** 5

This repo extends the expiry scanner and certification revoke path so an expired or revoked cert provably reaches the alerting snapshot.

## Scope
- Grant the Certification Expiry Scanner role (E3-S2-INFRA) conditional UpdateItem on CERTIFICATION items to set `status = EXPIRED`.
- HTTP API route for training-officer revoke (path per backend handler; not in the architecture endpoint table); role: conditional UpdateItem on CERTIFICATION + AUDIT_LOG_ENTRY.
- The stream → `certExpiredReactor.ts` → `outboxPublisher.ts` → bus → eligibility snapshot queue chain is provisioned by E2-S2-INFRA; this child adds a staging end-to-end check on that deployed chain, not new resources.

## Acceptance criteria
1. Given a cert past `expiryDate` in staging, when the scanner runs, then status becomes EXPIRED and the snapshot `quals` update within 30s p99 (AC1–AC3).
2. Given a training officer revokes a cert, when the route returns, then the same propagation occurs (AC5).
3. Given a following test dispatch, when fan-out computes eligibility, then the member is excluded for that qual (AC4).
4. Given the scanner, reactor, and alerting consumer roles, when IAM is simulated, then only the alerting consumer can touch the `alerting-service` table and it cannot touch `platform-service` (AC3).

## Current state
`boxalarm-infrastructure` at origin/main has only Cognito (`components/identity/*`) and observability (`components/observability/*`) — no API Gateway, DynamoDB table, EventBridge bus, SQS, Scheduler, or service Lambda exists yet. `personnel-service/events/certExpiredReactor.ts` (PR zdemanche/boxalarm-backend#27) already reacts to EXPIRED/REVOKED CERTIFICATION stream records. No alerting consumer for `personnel.eligibility.changed` exists (see E2-S2-INFRA), and no revoke handler exists.

## Depends on
- E2-S2-INFRA (chain), E3-S2-INFRA (scanner)
- backend: `personnel.eligibility.changed` consumer in alerting-service




---

## #207 — E2-S5-INFRA: Planned unavailability (marking off) that suppresses alerting

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/46 · **Wave:** 4

This repo deploys mark-off capture, its one-time expiry schedules, and the availability → alerting snapshot path with its staleness alarm.

## Scope
- HTTP API route `POST /api/v1/personnel/members/{memberId}/availability` → `availability/handler.ts`. Role: platform table read/write, `scheduler:CreateSchedule` (+ `DeleteSchedule` for its rollback path), `iam:PassRole` on the scheduler role, `verifiedpermissions:IsAuthorizedWithToken`.
- `availability/expiryHandler.ts` Lambda; EventBridge Scheduler execution role with `lambda:InvokeFunction` on it only.
- OUTBOX_ENTRY publisher on the table stream (E2-S1-INFRA) carries `personnel.availability.changed`.
- Bus rule `detail-type = personnel.availability.changed` → `boxalarm-{env}-availability-snapshot-queue` + DLQ (`maxReceiveCount: 5`, DLQ alarm pages on-call) → `alerting-service/eligibility/consumer.ts` Lambda; role limited to the `alerting-service` table; not VPC-attached.
- `alerting-service/eligibility/staleness/checkHandler.ts` on an EventBridge Scheduler rate schedule (every 5 min) with `DEPT_ID`; CloudWatch alarm on `Boxalarm/AlertingEligibility SnapshotStale > 0` (15-min staleness bound).

## Acceptance criteria
1. Given a member posts a mark-off, when it succeeds, then two one-time schedules exist targeting the expiry Lambda (AC1, AC4).
2. Given the start schedule fires, when the outbox publishes `personnel.availability.changed`, then the consumer sets `availabilityState = MARKED_OFF` (AC2, AC3); given the end schedule fires, it reverts to AVAILABLE (AC4).
3. Given a real fan-out in staging after mark-off, when the dispatch fans out, then the member is excluded (test notes: actual suppression, not just event emission).
4. Given a snapshot older than 15 min, when the check runs, then the SnapshotStale alarm fires (test notes).
5. Given the consumer role, when IAM is simulated against `platform-service`/`incident-service` tables, then all actions are denied.

## Current state
`boxalarm-infrastructure` at origin/main has only Cognito (`components/identity/*`) and observability (`components/observability/*`) — no API Gateway, DynamoDB table, EventBridge bus, SQS, Scheduler, or service Lambda exists yet.

Backend (PR zdemanche/boxalarm-backend#32) expects: `PLATFORM_TABLE_NAME`, `AVAILABILITY_EXPIRY_HANDLER_ARN`, `AVAILABILITY_SCHEDULER_ROLE_ARN` (`availability/handler.ts`), `PLATFORM_EVENT_BUS_NAME` (`outbox/publisher.ts`), `ALERTING_TABLE_NAME` (consumer), `DEPT_ID` (staleness check). Schedules are created in the default group with no `ActionAfterCompletion`, so fired schedules persist.

## Depends on
- E8-S7 (platform-service table with GSI1–3 + Streams), E8-S1 (HTTP API + shared authorizer route wiring; infrastructure#6 covers only the Cognito claim), E8-S3 (Verified Permissions policy store)
- E2-S1-INFRA (bus + outbox publisher)
- alerting-service table (E1 foundation infra)




---

## #208 — E2-S6-INFRA: Member self-service profile and contact update

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/47 · **Wave:** 4

This repo deploys the self-service profile endpoint and routes `personnel.member.updated` into the alerting snapshot.

## Scope
- HTTP API route `PUT /api/v1/personnel/members/{memberId}` → `members/updateMember.ts`; role: platform table UpdateItem/TransactWriteItems.
- Bus rule `detail-type = personnel.member.updated` → `boxalarm-{env}-member-snapshot-queue` + DLQ (`maxReceiveCount: 5`, DLQ alarm pages on-call) → **one** alerting-service snapshot handler; role limited to the `alerting-service` table; not VPC-attached.
- `personnel.member.updated` is also consumed by platform-service session revocation (E8-S8) — that is a separate queue owned by E8-S8-INFRA.

## Acceptance criteria
1. Given a member token, when `PUT /members/{self}` updates phone, then 200 and `updatedAt` advances (AC1).
2. Given the update, when the outbox event is published, then the alerting snapshot's `contactChannels` reflect the new phone within 30s p99 (AC3).
3. Given the alerting handler role, when IAM is simulated against the `platform-service` table, then all actions are denied.

## Current state
`boxalarm-infrastructure` at origin/main has only Cognito (`components/identity/*`) and observability (`components/observability/*`) — no API Gateway, DynamoDB table, EventBridge bus, SQS, Scheduler, or service Lambda exists yet.

Backend expects: `PLATFORM_TABLE_NAME` + `PLATFORM_BUS_NAME` (`personnel-service/config.ts`).

**Duplicate consumers:** two alerting handlers both maintain the snapshot from `personnel.member.updated` — `eligibility/memberUpdatedHandler.ts` (E1-S14, SQS partial-batch response) and `eligibility/maintainMemberSnapshot.ts` (E8-S4, `ALERTING_TABLE_NAME`, own dedup). Subscribe exactly one (default `memberUpdatedHandler.ts`) until backend consolidates.

## Depends on
- E8-S7 (platform-service table with GSI1–3 + Streams), E8-S1 (HTTP API + shared authorizer route wiring; infrastructure#6 covers only the Cognito claim), E8-S3 (Verified Permissions policy store)
- E2-S1-INFRA (bus + outbox publisher)




---

## #213 — E2-S11-INFRA: Shift attendance feeds LOSAP and reporting automatically

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/52 · **Wave:** 6

This repo deploys the scheduled shift-completion job that turns worked shifts into attendance.

## Scope
- EventBridge Scheduler recurring schedule (hourly; LOSAP is not latency-sensitive) → personnel-service shift-completion Lambda.
- Role: Query GSI3 `DEPT#{deptId}#DUTY_SHIFT` by `endAt`, TransactWriteItems for ATTENDANCE_RECORD + OUTBOX_ENTRY (+ completion marker) on the `platform-service` table.
- Scheduler retry policy + DLQ on the target; CloudWatch alarm on Lambda Errors and DLQ depth.

## Acceptance criteria
1. Given a claimed shift that ended, when the schedule fires, then one ATTENDANCE_RECORD with `refId = shiftId` is written, and a second run writes none (AC1).
2. Given that record, when the outbox publishes `personnel.attendance.recorded`, then it reaches the LOSAP accrual queue (AC2).
3. Given the job fails, when retries exhaust, then the DLQ alarm fires.

## Current state
`boxalarm-infrastructure` at origin/main has only Cognito (`components/identity/*`) and observability (`components/observability/*`) — no API Gateway, DynamoDB table, EventBridge bus, SQS, Scheduler, or service Lambda exists yet. Backend shift-completion handler not yet written.

## Depends on
- E8-S7 (platform-service table with GSI1–3 + Streams), E8-S1 (HTTP API + shared authorizer route wiring; infrastructure#6 covers only the Cognito claim), E8-S3 (Verified Permissions policy store)
- E2-S1-INFRA (outbox publisher), E2-S4-INFRA (accrual queue), E2-S8-INFRA




---

