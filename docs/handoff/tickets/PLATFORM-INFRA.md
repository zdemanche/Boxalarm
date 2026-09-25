# PLATFORM-INFRA: Deploy notification-service; fix status-route token revocation, audit-deny coverage, scheduled retention disposal, and three IAM gaps

**Key:** PLATFORM-INFRA
**Story:** E3-S3/E1-S13/E1-S14/E8-S5/E8-S9/E6-S2/E2-S9 infrastructure children
**Directory:** `infrastructure/`
**Issues:** #216, #232, #233, #257, #260, #237, #211

Seven concrete defects/gaps found on main:
- **#216 / #232** — notification-service has backend code (`backend/src/services/notification-service/`: cert-expiry, defect-reported, inventory-reorder, test-due consumers, digest job, inbox, preferences) but **no infrastructure at all**. Deploy it: bus rules → queues (+DLQ+alarm) → consumers, the daily digest Scheduler, `/api/v1/notifications*` routes, and the isolation IAM (notification-service is a LOB service; **it gets no alerting-table permission**). Add the notification-service isolation Pulumi test #232 asks for. Also #232: `checkHandler.ts`'s staleness check compares `now` to last-write time instead of propagation lag — that is a backend fix; note it as a residual (`Refs #232`) rather than editing `backend/`.
- **#233 (life-safety)** — the deployed `PUT .../members/{memberId}/status` route is bound to E2-S1's `updateStatus.ts`, which does not revoke push tokens; `pushTokens/statusChange.ts` (which does) is wired to nothing. Resolve so a status change to inactive revokes push tokens: wire the route so both behaviours happen (read both handlers; if one must call the other, that is a backend change — note it rather than making it, and pick the wiring that keeps the revocation).
- **#257** — `auditMutationDenyStatement` is on only 3 of ~15 platform-table-mutating roles. Add it to every one (training, personnel attendance/availability/losap/shifts/quals, incident, and every new role in this run) and add a Vitest assertion that walks **all** roles with platform-table write actions and fails if any lacks it.
- **#260** — the daily retention Scheduler invokes `disposalHandler.ts` directly, but that handler expects an API-Gateway event with a bearer token, so scheduled runs 401 and dispose nothing. Point the schedule at a scheduler-shaped entry (if one doesn't exist in `backend/`, note it as a residual and `Refs #260`).
- **#237** — the incident create Lambda's role omits `dynamodb:TransactWriteItems`, but `repository.ts` issues a `TransactWriteCommand` on create. Add it.
- **#211** — the shift coverage read route shares a Lambda/role with claim/release/swap (PutItem/UpdateItem). AC3 requires the coverage role to hold no write action: give coverage its own read-only Lambda + role.

## Standing notes (apply to every issue below)

- **Monorepo.** Repo root is `/Users/zacharydemanche/Projects/boxalarm`. This run touches **only `infrastructure/`** (plus tests inside it). Other bundle runs edit other areas concurrently; do not touch them.
- **The issues' "Current state" sections are stale** — written before ~30 batch PRs merged. Verify everything against `main`; reuse what exists, never duplicate it.
- **Wording constraint for the plan document.** A mechanical plan gate greps for the literal string `caller-supplied` (and `caller supplies`) and fails the plan on a match, even inside a sentence that denies it. Never use those phrases. Say "derived server-side from the verified token" / "originates from the authenticated principal" instead.
- **Alerting invariants** (life-safety): alerting plane is SNS FIFO; routing and dedup key on `channel` (never `channelTier`); exactly-once key `{dispatchId}#{toneSequence}#{memberId}#{channel}`; alerting isolation is an **IAM boundary** — no LOB role gains any alerting-table permission, alerting Lambdas stay out of any VPC; `{deptId}` is in every partition key.
- Auth is settled: no MFA, no step-up, no session timeout.
- One PR closes the issues below as `Closes #n`; use `Refs #n` for any issue a note says is only partly delivered.
- **Reuse the existing infra patterns exactly** — read first: `infrastructure/components/training/*.ts`, `infrastructure/components/incident/incident.ts`, `infrastructure/components/personnel/*.ts` (route + arm64 Lambda + least-privilege role per handler, `lambdaCode(service, fn)` from `backend/scripts/lambda-manifest.mjs`), `infrastructure/components/messaging/queue-consumer.ts` (`QueueConsumer`/`addQueueConsumer`), `messaging/outbox-publisher.ts`, `api/http-api.ts`, `infrastructure/index.ts`. If a handler is missing from `backend/scripts/lambda-manifest.mjs`, appending its entry there is the one permitted edit outside `infrastructure/`.
- **Concurrent infra runs** (E5-INFRA inspections, ELIG-INFRA eligibility wiring, and one more) also edit `infrastructure/index.ts`. Keep your `index.ts` change to one self-contained block that instantiates your component(s) so merges stay trivial; put everything else in new/own component files.
- **U.S. residency gate:** `infrastructure/test/residency-encryption.test.ts` fails any global-edge resource. **No CloudFront.** Where an issue says CloudFront signed URLs, use region-pinned S3 presigned URLs.
- Every mutating LOB role that writes the platform table must include `auditMutationDenyStatement` (find it in the repo) — E8-S5 AC4.
- Tests: Vitest over the Pulumi resource graph in the style of `infrastructure/test/*.test.ts` — routes exist behind the authorizer, each role grants only its listed actions/resources, queues have DLQ + alarm.


---

# Issues in this bundle

## #216 — E3-S3-INFRA: Digest-batched cert expiry notifications to member and training officer

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/55 · **Wave:** 6

This repo deploys notification-service on the LOB plane: cert-expiry intake, daily digest, inbox/preferences API, and non-critical push + email, fully separate from alerting.

## Scope
- Bus rule `detail-type = cert.expiry.due` → `boxalarm-{env}-training-notify-queue` + DLQ (`maxReceiveCount: 5`, depth alarm) → notification-service intake Lambda (writes pending digest items).
- EventBridge Scheduler daily → digest Lambda (one push + one email per member per day; training-officer digest).
- HTTP API routes: `GET /api/v1/notifications`, `POST /api/v1/notifications/{id}/read`, `GET` + `PUT /api/v1/notifications/preferences`.
- Push: non-critical APNs/FCM credentials in their own Secrets Manager secret(s); email: SES domain identity + `ses:SendEmail` on the notification roles only.
- Isolation: SQS event-source `MaximumConcurrency` cap on the intake mapping; notification roles hold no permission on the alerting SNS FIFO topic, alerting queues, alerting table, or alerting provider secrets; no subscription to the alerting topic.
- Roles: `platform-service` table read/write (NOTIFICATION, NOTIFICATION_PREFERENCE).

## Acceptance criteria
1. Given N `cert.expiry.due` events for one member in a day, when the digest runs, then one push and one email are sent (AC1).
2. Given IAM simulation, when notification roles are tested against every alerting-plane resource, then all are denied (AC5).
3. Given the staging chaos test saturates the training-notify queue, when a canary dispatch fans out concurrently, then alerting latency and success are unchanged (AC5, NOTIF-ISO).
4. Given the four notification routes, when called with a member token, then 2xx (AC4, AC6).

## Current state
`boxalarm-infrastructure` at origin/main has only Cognito (`components/identity/*`) and observability (`components/observability/*`) — no API Gateway, DynamoDB table, EventBridge bus, SQS, Scheduler, or service Lambda exists yet. `src/services/notification-service/index.ts` is only a service descriptor; no handlers exist.

## Depends on
- E8-S7 (platform-service table with GSI1–3 + Streams), E8-S1 (HTTP API + shared authorizer route wiring; infrastructure#6 covers only the Cognito claim), E8-S3 (Verified Permissions policy store)
- E2-S1-INFRA (platform bus)
- E3-S2-INFRA (event producer)
- boxalarm-docs#3 (Apple entitlement work decides the critical vs non-critical APNs split)




---

## #232 — E1-S13-INFRA: Notification service isolation regression test and IAM enforcement

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/38 · **Wave:** 6

Makes alerting isolation an enforced IAM boundary with policy tests, and wires the eligibility-staleness alarm.

## Scope
- IAM permissions boundary `boxalarm-{env}-alerting-plane-boundary`, attached to **every** alerting-service role. It explicitly denies all DynamoDB actions on the platform-service and incident-service table, index and stream ARNs.
- Pulumi test suite that enumerates all alerting roles and asserts:
  - the boundary is attached
  - no Allow references a non-alerting table
  - the alerting topic has subscribers only from alerting queues
  - `messaging-alerting.ts` and `messaging.ts` share no resource
- notification-service:
  - consumes only `boxalarm-{env}-platform-bus` rules → its own queues/DLQs
  - its own reserved concurrency and its own push credentials/non-critical channel
  - test asserts its roles hold no permission on alerting topic, queues or secrets
- Staleness:
  - EventBridge Scheduler recurring schedule (every 5 minutes) invoking `src/services/alerting-service/eligibility/staleness/checkHandler.handler`, env `ALERTING_TABLE_NAME`, `DEPT_ID`; one schedule per department
  - CloudWatch alarm on `SnapshotStale > 0` (namespace as emitted, `Boxalarm/AlertingEligibility`) → `alerting-page`
- `ApproximateAgeOfOldestMessage` alarm (30s) on each snapshot consumer queue.

## Acceptance criteria
- Given the policy tests, when any alerting role lacks the boundary or grants platform/incident table access, then CI fails (parent AC1, AC3).
- Given notification-service resources, when inspected, then they share no queue, concurrency reservation, SNS topic or provider secret with alerting (parent AC2).
- Given snapshot staleness in dev, when an item exceeds the threshold, then the alarm fires (parent AC5).
- Given a consumer-queue backlog older than 30s, when evaluated, then the age alarm fires (parent AC5 propagation target).

## Current state
- Infra: nothing but identity + observability.
- Backend `staleness/checkHandler.ts` (from boxalarm-backend#32) counts items whose `snapshotUpdatedAt` is older than 15 minutes. A member with no recent change is counted, so the alarm would fire permanently. Backend should measure propagation lag instead before this alarm is enabled.

## Depends on
- E1-S2-INFRA
- E1-S11-INFRA (`alerting-page` topic)
- The snapshot consumer queues from the E2-S2 / E2-S5 / E2-S6 infra children and E1-S14-INFRA



---

## #233 — E1-S14-INFRA: Register and rotate device push tokens

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/39 · **Wave:** 4

Deploys the merged push-token handlers: the personnel routes, the `personnel.member.updated` crossing into the alerting snapshot, and the push receipt webhook.

## Scope
- **Personnel routes** (shared authorizer):
  - `POST` and `DELETE /api/v1/personnel/members/{memberId}/push-tokens` → `pushTokens/registerToken.handler`, `pushTokens/revokeToken.handler`
  - `PUT /api/v1/personnel/members/{memberId}/status` (see Current state)
  - env `PERSONNEL_TABLE_NAME` (the platform-service table), `VERIFIED_PERMISSIONS_POLICY_STORE_ID`
  - IAM: `GetItem`/`TransactWriteItems` on the platform-service table only, `verifiedpermissions:IsAuthorizedWithToken`
- **Alerting consumer:**
  - `boxalarm-{env}-platform-bus` rule `detail-type = personnel.member.updated` → `boxalarm-{env}-alerting-member-updated-queue` + DLQ (`maxReceiveCount: 5`, the LOB-crossing tier like `alert-rules-copy-queue`)
  - Lambda `eligibility/memberUpdatedHandler.handler` with `ReportBatchItemFailures`
  - env `ALERTING_TABLE_NAME`; IAM `GetItem`/`PutItem`/`UpdateItem` on the alerting table only
- **Push receipt webhook:**
  - `POST /api/v1/alerting/receipts/push`, no JWT authorizer, → `receipts/pushReceiptHandler.handler`
  - env `PUSH_PROVIDER_WEBHOOK_SECRET` (Pulumi secret), `ALERTING_TABLE_NAME`
  - IAM `GetItem`/`UpdateItem` on the alerting table

## Acceptance criteria
- Given a member registers a token in dev, when the outbox event propagates, then the alerting `MEMBER_ELIGIBILITY_SNAPSHOT.contactChannels` holds the token within 30s (parent AC1).
- Given a permanent invalid-token webhook with the correct secret, when received, then the snapshot push entry becomes `valid:false`; a wrong secret returns 401 (parent AC4).
- Given a member set inactive, when the status route runs, then their tokens are revoked (parent AC5).
- Given the Pulumi tests, when roles are inspected, then personnel roles have no alerting-table permission and alerting roles have no platform-table permission.

## Current state
- Backend merged in boxalarm-backend#34. Nothing is deployed.
- **Blocking backend conflicts to resolve before wiring:**
  - `PUT .../members/{memberId}/status` is handled by both `personnel-service/members/updateStatus.ts` (E2-S1) and `pushTokens/statusChange.ts` (E1-S14); a route takes one integration. Default: E2-S1's handler owns the route, with token revocation folded in.
  - `personnel.member.updated` has two snapshot consumers: `eligibility/maintainMemberSnapshot.ts` (from E8-S4, boxalarm-backend#20) and `eligibility/memberUpdatedHandler.ts`. Wire one; the default is `memberUpdatedHandler`.
  - Personnel config reads `PERSONNEL_TABLE_NAME`, `PLATFORM_TABLE_NAME` or `PLATFORM_SERVICE_TABLE_NAME`, and bus `PLATFORM_BUS_NAME` vs `PLATFORM_EVENT_BUS_NAME`, depending on file.
- Open review finding P9 (boxalarm-backend#34): the push webhook trusts `deptId` from the request body.

## Depends on
- E1-S1-INFRA (alerting table)
- E2-S1 / E2-S2 infra children (platform table, personnel outbox publisher to the bus)
- E8-S1 HTTP API + authorizer
- E8-S3 policy store



---

## #257 — E8-S5-INFRA: Tamper-evident audit log for every record mutation

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/105 · **Wave:** 1

The platform-service table with its GSIs, the audit query route, IAM separation of audit writes, and the tamper-evidence trail.

## Scope
- `boxalarm-{env}-platform-service` table (first Wave 1 story needing it): on-demand, PITR, Streams, AWS-managed key.
  - GSI1 `MEMBER#{memberId}`
  - GSI2 `DEPT#{deptId}#DUE#{entityType}#{YYYY-MM}`
  - GSI3 department lists/geo/audit-by-entity
- `GET /api/v1/platform/audit` → `platform-service/audit/handler.ts` Lambda. Env `AUDIT_TABLE_NAME`. `Query` on GSI3 only.
- IAM separation (AC4): every mutating LOB service role gets an explicit Deny on `dynamodb:UpdateItem`/`DeleteItem` where `dynamodb:LeadingKeys` matches `DEPT#*#AUDIT#*`. Put-overwrite of an existing audit key cannot be IAM-restricted; it is prevented in code by `auditEntry.ts`'s `attribute_not_exists(pk) AND attribute_not_exists(sk)`, with the Object Lock archive as backstop.
- CloudTrail trail with DynamoDB data events on the alerting-service table. Audit archive S3 bucket with Object Lock in compliance mode. The archival job itself is Wave 3.

## Acceptance criteria
1. Given an admin token, when `GET /platform/audit` is called for an entity, then the Lambda queries GSI3 and returns history (AC2).
2. Given any mutating service role, when simulated, then `UpdateItem`/`DeleteItem` on `DEPT#*#AUDIT#*` keys is denied (AC4).
3. Given the trail, when inspected, then it records DynamoDB data events for the alerting table and delivers to a bucket with Object Lock compliance mode (AC3).

## Current state
- Backend PR zdemanche/boxalarm-backend#21 merged `audit/auditEntry.ts` (composable transact item), `audit/handler.ts` and `queryAuditTrail.ts` (GSI3 key `DEPT#{deptId}#AUDIT#ENTITY#{type}#{id}`).
- No table, trail or bucket in infra.

## Depends on
- infrastructure#6, E8-S3-INFRA, E8-S11-INFRA.
- The alerting-service table child (E1 stories) for the data-event selector.



---

## #260 — E8-S9-INFRA: Records retention configuration and verified disposal

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/109 · **Wave:** 1

The disposal job's schedule and least-privilege role, crypto-shred keys, and per-invocation alarming.

## Scope
- Disposal Lambda on an EventBridge Scheduler schedule (daily), plus an admin-triggered route (CHIEF/ADMIN Cedar-gated via E8-S3-INFRA; path pinned with backend).
- Disposal role:
  - `Query`/`DeleteItem`/`BatchWriteItem` on platform-service table LOB classes.
  - Explicit Deny on `dynamodb:LeadingKeys` `DEPT#*#AUDIT#*`.
  - **No grant on the alerting-service table** (DELIVERY_RECEIPT and DISPATCH_ALERT are unreachable).
  - No delete on the incident table. NERIS_SUBMISSION_ATTEMPT shares the incident pk, so incident-class records are crypto-shred only.
- Crypto-shred: per-class archive CMKs (archived incident; archived delivery receipt), distinct from the live table CMKs. The disposal role holds `kms:ScheduleKeyDeletion` on archive keys only, never on table keys.
- Chief notification SNS topic, shared with E8-S6-INFRA. An alarm on every disposal invocation.

## Acceptance criteria
1. Given an LOB record past retention, when disposal runs, then the role can delete it and a follow-up GetItem/Query returns nothing (AC2).
2. Given the disposal role, when simulated, then the alerting table, audit keys, incident-table deletes and table CMKs are all denied (AC4).
3. Given an archived class at end of retention, when disposal runs, then its archive CMK is scheduled for deletion and live table CMKs are unaffected (AC3).
4. Given any disposal invocation, when it runs, then the chief alarm fires.

## Current state
- No retention or disposal code in backend, and nothing in infra.

## Depends on
- E8-S5-INFRA (platform table), E8-S3-INFRA, infrastructure#6.
- Archived data only exists once the Wave 3 S3-Glacier archival job ships (out of this story's done-criteria).



---

## #237 — E6-S2-INFRA: Create incident pre-populated from alert, CAD, and response roster

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/84 · **Wave:** 7

Create-incident route, plus a way to get dispatch/roster data to incident-service without breaking the alerting isolation boundary.

## Scope
- `POST /api/v1/incidents` on the shared HTTP API behind the shared Lambda authorizer → incident-service create Lambda. VPC-less, active tracing.
- Create Lambda IAM: `PutItem`/`TransactWriteItems`/`GetItem`/`Query` on the incident table, `kms:Encrypt`/`Decrypt` on the incident CMK, `verifiedpermissions:IsAuthorizedWithToken`. **No grant on the alerting-service table.**
- Pre-population source: `boxalarm-{env}-platform-bus` rules for the already-bridged `dispatch.alert.received` and `alerting.response.confirmed` events → `incident-dispatch-copy-queue` + DLQ (`maxReceiveCount: 5`) → incident-service consumer Lambda that writes a local dispatch/roster copy to the incident table. The queue name is proposed; the architecture doesn't name one.
- DLQ-depth alarm → standard on-call (not the alerting page path).

## Acceptance criteria
1. Given a dispatch and roster republished onto the platform bus, when the consumer runs, then the incident table holds the copy that `POST /incidents` pre-fills from (AC1, AC2).
2. Given the create and consumer roles, when simulated against the alerting-service table, then every action is denied.
3. Given a request with no valid token, when it hits the route, then the authorizer rejects it before the Lambda is invoked (AC3 path).
4. Given the consumer fails repeatedly, when the message exhausts retries, then it lands in the DLQ and the alarm fires.

## Current state
- No HTTP API, routes, Lambdas, bus or queues in `boxalarm-infrastructure`.
- The incident-service fact sheet says the dispatch is resolved via an independent `GetItem`/`Query`. That would need an alerting-table grant, which the architecture reserves for the export role only (Data Protection, Export IAM path). That's why this child routes pre-population through the one-way bridge instead.

## Depends on
- E6-S1-INFRA, infrastructure#6 (HTTP API + authorizer), E8-S3-INFRA, E8-S8-INFRA (platform bus), E8-S11-INFRA (service Lambda baseline).
- The alerting-plane bridge rule that republishes `dispatch.alert.received` / `alerting.response.confirmed` (E1 stories).



---

## #211 — E2-S9-INFRA: Shift coverage visibility

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/50 · **Wave:** 5

This repo deploys the shift-coverage read endpoint.

## Scope
- HTTP API route `GET /api/v1/personnel/shifts/coverage` → personnel-service coverage Lambda.
- Role: read-only Query on GSI3 (`DUTY_SHIFT`) and member-qual reads on the `platform-service` table; `verifiedpermissions:IsAuthorizedWithToken`.

## Acceptance criteria
1. Given an officer token, when the route is called, then 2xx with per-shift covered/short/qual-gapped (AC1, AC2).
2. Given the role, when IAM is inspected, then it holds no write action (AC3: surfaced only, no automatic action).

## Current state
`boxalarm-infrastructure` at origin/main has only Cognito (`components/identity/*`) and observability (`components/observability/*`) — no API Gateway, DynamoDB table, EventBridge bus, SQS, Scheduler, or service Lambda exists yet. Backend coverage handler not yet written.

## Depends on
- E8-S7 (platform-service table with GSI1–3 + Streams), E8-S1 (HTTP API + shared authorizer route wiring; infrastructure#6 covers only the Cognito claim), E8-S3 (Verified Permissions policy store)
- E2-S7-INFRA, E2-S8-INFRA




---

