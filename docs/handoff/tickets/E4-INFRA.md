# E4-INFRA: Deploy apparatus-service and inventory-service (registry, check sheets, checks, defects, OOS, maintenance, SCBA, testing, compartment inventory, compliance, equipment, PPE, consumables, lifecycle)

**Key:** E4-INFRA
**Story:** E4-S1..E4-S14 infrastructure children
**Directory:** `infrastructure/`
**Issues:** #181, #182, #183, #184, #185, #186, #187, #188, #189, #190, #191, #192, #193, #194

Every handler these stories need already exists on main under `backend/src/services/apparatus-service/` and `backend/src/services/inventory-service/`, and the UI is built — but `infrastructure/` deploys **none** of it (no apparatus/inventory component, zero `/api/v1/apparatus` or `/api/v1/inventory` routes). Create `infrastructure/components/apparatus/` and `infrastructure/components/inventory/` and deploy all of it: routes, per-handler roles, the scanners' EventBridge Scheduler jobs, and the notify queues the scanners publish to. Where #181 notes two list handlers for the same route, wire the E4-S5 one that carries out-of-service fields. **Exception:** the riding-board routes already live in apparatus-service on main (E1-S18) — find where they're wired and don't duplicate them. Defect photos (#184) use S3 presigned URLs, not CloudFront.

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

## #181 — E4-S1-INFRA: Apparatus registry with in/out-of-service status

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/61 · **Wave:** 3

Deploy the merged apparatus registry handlers behind the HTTP API.

## Scope
- Routes: `GET /api/v1/apparatus`, `GET /api/v1/apparatus/{unitId}`, `POST /api/v1/apparatus` (authorizer on all).
- arm64 Lambda(s), not VPC-attached, log group from `ServiceLogGroup`: `src/services/apparatus-service/listApparatus.ts`, `getApparatus.ts`, `createApparatus.ts` (+ `livenessHandler.ts`/`readinessHandler.ts`). Execution role: `dynamodb:GetItem/PutItem/Query` on the platform table and its `GSI3` index ARN only; `verifiedpermissions:IsAuthorizedWithToken`/`BatchIsAuthorizedWithToken` on the policy store; X-Ray write. Env: `PLATFORM_TABLE_NAME`, `VERIFIED_PERMISSIONS_POLICY_STORE_ID`.
- No permission on the alerting or incident tables.

## Acceptance criteria
- Given the stack deploys, when an admin POSTs an apparatus, then it is readable via both GET routes (AC1).
- Given a request without a valid JWT, when any route is called, then the authorizer rejects it before the Lambda runs (E8-S1).
- Given the execution role, when inspected, then it grants no table other than platform-service.

## Current state
- `boxalarm-infrastructure` origin/main has only `components/identity/*` (Cognito pool/clients) and `components/observability/*` (log groups, dashboards, X-Ray sampling for all 10 services). No DynamoDB table, HTTP API route, Lambda, EventBridge bus, SQS queue, S3 bucket or CloudFront distribution exists yet.
- Backend has two registry list handlers: `listApparatus.ts` (E4-S1, PR 15) and `listHandler.ts` (E4-S5, PR 37) for the same `GET /apparatus`; wire one (the E4-S5 one carries OOS fields) and flag the other for deletion.
- DynamoDB index names are case-sensitive and backend main mixes `GSI1/GSI2/GSI3` (apparatus, hydrant, map, training, platform audit) with `gsi1/gsi2/gsi3` (inventory equipment, listInspections, personnel shifts). The table defines one spelling; the backend must be normalized to it before these routes work.

## Depends on
- Platform foundation from the E8 children: `platform-service` table (on-demand, PITR, Streams, GSI1-GSI3), HTTP API + shared Lambda authorizer (E8-S1, `infrastructure#6`), Verified Permissions policy store (E8-S3).




---

## #182 — E4-S2-INFRA: Configurable per-apparatus check-sheet templates

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/62 · **Wave:** 4

Deploy the merged checklist-resolution handler.

## Scope
- Route: `GET /api/v1/apparatus/{unitId}/checklist`.
- arm64 Lambda(s), not VPC-attached, log group from `ServiceLogGroup`: `src/services/apparatus-service/getChecklistHandler.ts`. Execution role: `dynamodb:GetItem/Query` on the platform table and `GSI3` (read-only); `verifiedpermissions:IsAuthorizedWithToken`/`BatchIsAuthorizedWithToken` on the policy store; X-Ray write. Env: `PLATFORM_TABLE_NAME`, `VERIFIED_PERMISSIONS_POLICY_STORE_ID`.

## Acceptance criteria
- Given a template applies to a unit, when the route is called, then the Lambda returns it (AC1).
- Given the role, when inspected, then it has no DynamoDB write actions.

## Current state
- `boxalarm-infrastructure` origin/main has only `components/identity/*` (Cognito pool/clients) and `components/observability/*` (log groups, dashboards, X-Ray sampling for all 10 services). No DynamoDB table, HTTP API route, Lambda, EventBridge bus, SQS queue, S3 bucket or CloudFront distribution exists yet.
- DynamoDB index names are case-sensitive and backend main mixes `GSI1/GSI2/GSI3` (apparatus, hydrant, map, training, platform audit) with `gsi1/gsi2/gsi3` (inventory equipment, listInspections, personnel shifts). The table defines one spelling; the backend must be normalized to it before these routes work.

## Depends on
- Platform foundation from the E8 children: `platform-service` table (on-demand, PITR, Streams, GSI1-GSI3), HTTP API + shared Lambda authorizer (E8-S1, `infrastructure#6`), Verified Permissions policy store (E8-S3).
- E4-S1-INFRA




---

## #183 — E4-S3-INFRA: Complete a glove-friendly truck check in under 90 seconds, offline-capable

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/63 · **Wave:** 5

Route and Lambda for check submission with idempotent writes.

## Scope
- Route: `POST /api/v1/apparatus/{unitId}/checks`.
- arm64 Lambda(s), not VPC-attached, log group from `ServiceLogGroup`: the check-submission handler E4-S3 backend adds under `src/services/apparatus-service/`. Execution role: `dynamodb:PutItem/ConditionCheckItem/TransactWriteItems/GetItem/Query` on the platform table + `GSI3` (idempotency conditional put); `verifiedpermissions:IsAuthorizedWithToken`/`BatchIsAuthorizedWithToken` on the policy store; X-Ray write. Env: `PLATFORM_TABLE_NAME`, `VERIFIED_PERMISSIONS_POLICY_STORE_ID`.
- Dashboard: add `durationSeconds` p50 widget to the apparatus-service `ServiceDashboard` for N4.2 monitoring (EMF metric, no extra IAM).

## Acceptance criteria
- Given a retried submission with the same idempotency key, when the Lambda runs twice, then one `CHECKLIST_RUN` exists (AC4).
- Given the apparatus-service dashboard, when a check completes, then its duration appears in the N4.2 widget (AC5).

## Current state
- `boxalarm-infrastructure` origin/main has only `components/identity/*` (Cognito pool/clients) and `components/observability/*` (log groups, dashboards, X-Ray sampling for all 10 services). No DynamoDB table, HTTP API route, Lambda, EventBridge bus, SQS queue, S3 bucket or CloudFront distribution exists yet.
- Backend: no checks handler on main yet.

## Depends on
- Platform foundation from the E8 children: `platform-service` table (on-demand, PITR, Streams, GSI1-GSI3), HTTP API + shared Lambda authorizer (E8-S1, `infrastructure#6`), Verified Permissions policy store (E8-S3).
- E4-S2-INFRA




---

## #184 — E4-S4-INFRA: Report a defect with photo, routed to the apparatus officer

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/64 · **Wave:** 7

Defect route, photo storage prefix, outbox publication, and bus rule to notification-service.

## Scope
- Route: `POST /api/v1/apparatus/{unitId}/defects`; Lambda role adds `secretsmanager:GetSecretValue` on the CloudFront signing-key secret and the `PLATFORM_ASSETS_*` env vars (same as E5-S2-INFRA) for `{deptId}/DEFECT/{defectId}/` uploads.
- arm64 Lambda(s), not VPC-attached, log group from `ServiceLogGroup`: the defect handler E4-S4 backend adds. Execution role: `dynamodb:TransactWriteItems/PutItem/GetItem/Query` on the platform table + `GSI3`; `verifiedpermissions:IsAuthorizedWithToken`/`BatchIsAuthorizedWithToken` on the policy store; X-Ray write. Env: `PLATFORM_TABLE_NAME`, `VERIFIED_PERMISSIONS_POLICY_STORE_ID`.
- Publication: reuse the platform-table outbox drain from E5-S2-INFRA (it publishes any `OUTBOX_RECORD`, `source` preserved) - no second stream reader.
- `boxalarm-{env}-platform-bus` rule on `detail-type = apparatus.defect.reported` -> `apparatus-notify-queue` (standard SQS) + DLQ, `maxReceiveCount: 5`, DLQ depth alarm.
- Event source mapping `apparatus-notify-queue` -> notification-service consumer Lambda (handler from E3-S3). NOTIF-ISO: no reserved concurrency, queue, topic or provider credential shared with alerting; role has no alerting-table or alerting-topic permission.

## Acceptance criteria
- Given a defect write, when the outbox record streams, then `apparatus.defect.reported` lands on `apparatus-notify-queue` (AC2).
- Given notification-service's role and queues, when inspected by an IAM policy test, then nothing references alerting-plane resources (AC3, NOTIF-ISO).
- Given a photo upload URL, when used outside `{deptId}/DEFECT/{defectId}/` or after 10 minutes, then CloudFront rejects it (AC1).

## Current state
- `boxalarm-infrastructure` origin/main has only `components/identity/*` (Cognito pool/clients) and `components/observability/*` (log groups, dashboards, X-Ray sampling for all 10 services). No DynamoDB table, HTTP API route, Lambda, EventBridge bus, SQS queue, S3 bucket or CloudFront distribution exists yet.
- Backend: no defect handler on main; apparatus-service must write `OUTBOX_RECORD` via `@boxalarm/outbox` to be drained.

## Depends on
- Platform foundation from the E8 children: `platform-service` table (on-demand, PITR, Streams, GSI1-GSI3), HTTP API + shared Lambda authorizer (E8-S1, `infrastructure#6`), Verified Permissions policy store (E8-S3).
- E5-S2-INFRA (platform-assets bucket, CloudFront, outbox drain, bus)
- E3-S3 (notification-service consumer)




---

## #185 — E4-S5-INFRA: Out-of-service tracking with reason, duration, and availability impact

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/65 · **Wave:** 4

Deploy the merged service-status and OOS-aware registry handlers.

## Scope
- Route: `PUT /api/v1/apparatus/{unitId}/service-status`; `GET /api/v1/apparatus` bound to `listHandler.ts` (see E4-S1-INFRA note).
- arm64 Lambda(s), not VPC-attached, log group from `ServiceLogGroup`: `src/services/apparatus-service/serviceStatusHandler.ts`, `listHandler.ts`. Execution role: `dynamodb:TransactWriteItems/UpdateItem/PutItem/GetItem/Query` on the platform table + `GSI3`; `verifiedpermissions:IsAuthorizedWithToken`/`BatchIsAuthorizedWithToken` on the policy store; X-Ray write. Env: `PLATFORM_TABLE_NAME`, `VERIFIED_PERMISSIONS_POLICY_STORE_ID`.

## Acceptance criteria
- Given an officer PUTs OUT_OF_SERVICE, when the Lambda runs, then status flips and an open OOS record is written atomically (AC1, AC2).
- Given a non-admin token, when PUT is called, then Verified Permissions denies with 403 (AC4).

## Current state
- `boxalarm-infrastructure` origin/main has only `components/identity/*` (Cognito pool/clients) and `components/observability/*` (log groups, dashboards, X-Ray sampling for all 10 services). No DynamoDB table, HTTP API route, Lambda, EventBridge bus, SQS queue, S3 bucket or CloudFront distribution exists yet.
- Backend env: `client.ts` reads `PLATFORM_TABLE_NAME`.
- DynamoDB index names are case-sensitive and backend main mixes `GSI1/GSI2/GSI3` (apparatus, hydrant, map, training, platform audit) with `gsi1/gsi2/gsi3` (inventory equipment, listInspections, personnel shifts). The table defines one spelling; the backend must be normalized to it before these routes work.

## Depends on
- Platform foundation from the E8 children: `platform-service` table (on-demand, PITR, Streams, GSI1-GSI3), HTTP API + shared Lambda authorizer (E8-S1, `infrastructure#6`), Verified Permissions policy store (E8-S3).
- E4-S1-INFRA




---

## #186 — E4-S6-INFRA: Maintenance history and scheduled maintenance

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/66 · **Wave:** 4

Deploy the merged maintenance handlers.

## Scope
- Routes: `GET` and `POST /api/v1/apparatus/{unitId}/maintenance`.
- arm64 Lambda(s), not VPC-attached, log group from `ServiceLogGroup`: `src/services/apparatus-service/getMaintenance.ts`, `postMaintenance.ts`. Execution role: `dynamodb:PutItem/GetItem/Query` on the platform table + `GSI2`/`GSI3`; `verifiedpermissions:IsAuthorizedWithToken`/`BatchIsAuthorizedWithToken` on the policy store; X-Ray write. Env: `PLATFORM_TABLE_NAME`, `VERIFIED_PERMISSIONS_POLICY_STORE_ID`.

## Acceptance criteria
- Given a POST with scheduledNextAt, when it runs, then the record carries GSI2 due keys and GET returns it (AC1-AC3).

## Current state
- `boxalarm-infrastructure` origin/main has only `components/identity/*` (Cognito pool/clients) and `components/observability/*` (log groups, dashboards, X-Ray sampling for all 10 services). No DynamoDB table, HTTP API route, Lambda, EventBridge bus, SQS queue, S3 bucket or CloudFront distribution exists yet.
- Backend env: `dynamoClient.ts` reads `PLATFORM_TABLE_NAME`.

## Depends on
- Platform foundation from the E8 children: `platform-service` table (on-demand, PITR, Streams, GSI1-GSI3), HTTP API + shared Lambda authorizer (E8-S1, `infrastructure#6`), Verified Permissions policy store (E8-S3).
- E4-S1-INFRA




---

## #187 — E4-S7-INFRA: SCBA unit, cylinder, flow-test, and hydro-test records

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/67 · **Wave:** 7

SCBA and testing-schedule routes plus the daily Apparatus Testing Scanner.

## Scope
- Routes: `POST /api/v1/apparatus/{unitId}/scba`, `GET /api/v1/apparatus/testing-schedules`.
- arm64 Lambda(s), not VPC-attached, log group from `ServiceLogGroup`: SCBA and testing-schedules handlers from E4-S7 backend. Execution role: `dynamodb:PutItem/GetItem/Query` on the platform table + `GSI2`; `verifiedpermissions:IsAuthorizedWithToken`/`BatchIsAuthorizedWithToken` on the policy store; X-Ray write. Env: `PLATFORM_TABLE_NAME`, `VERIFIED_PERMISSIONS_POLICY_STORE_ID`.
- Apparatus Testing Scanner: EventBridge Scheduler daily schedule -> scanner Lambda (GSI2 read-only; writes `OUTBOX_RECORD` for `apparatus.test.due`, drained by E5-S2-INFRA's outbox drain). Shared with E4-S8 - create once.
- Bus rule `detail-type = apparatus.test.due` -> `apparatus-notify-queue` + DLQ (create if E4-S4-INFRA has not).

## Acceptance criteria
- Given a due SCBA test, when the daily schedule fires, then `apparatus.test.due` reaches `apparatus-notify-queue` (AC3).
- Given scanner failure, when the invocation errors, then a CloudWatch alarm fires (no silent skip).

## Current state
- `boxalarm-infrastructure` origin/main has only `components/identity/*` (Cognito pool/clients) and `components/observability/*` (log groups, dashboards, X-Ray sampling for all 10 services). No DynamoDB table, HTTP API route, Lambda, EventBridge bus, SQS queue, S3 bucket or CloudFront distribution exists yet.
- Backend: no SCBA, testing-schedules or scanner handler on main.

## Depends on
- Platform foundation from the E8 children: `platform-service` table (on-demand, PITR, Streams, GSI1-GSI3), HTTP API + shared Lambda authorizer (E8-S1, `infrastructure#6`), Verified Permissions policy store (E8-S3).
- E5-S2-INFRA (outbox drain, bus)
- E3-S3 (notification consumer)




---

## #188 — E4-S8-INFRA: Hose, ladder, pump, and aerial testing schedules with due-alerting

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/68 · **Wave:** 7

Test-record write route; reuses E4-S7's scanner, schedule and notify rule.

## Scope
- Route: the `APPARATUS_TEST_RECORD` write route E4-S8 backend defines under `/api/v1/apparatus/{unitId}/`.
- arm64 Lambda(s), not VPC-attached, log group from `ServiceLogGroup`: the test-record handler. Execution role: `dynamodb:PutItem/GetItem/Query` on the platform table + `GSI2`; `verifiedpermissions:IsAuthorizedWithToken`/`BatchIsAuthorizedWithToken` on the policy store; X-Ray write. Env: `PLATFORM_TABLE_NAME`, `VERIFIED_PERMISSIONS_POLICY_STORE_ID`.
- Scanner schedule and `apparatus.test.due` rule: reuse E4-S7-INFRA; create here only if E4-S8 lands first.

## Acceptance criteria
- Given a test due within lead time, when the daily scanner runs, then `apparatus.test.due` reaches `apparatus-notify-queue` (AC2).

## Current state
- `boxalarm-infrastructure` origin/main has only `components/identity/*` (Cognito pool/clients) and `components/observability/*` (log groups, dashboards, X-Ray sampling for all 10 services). No DynamoDB table, HTTP API route, Lambda, EventBridge bus, SQS queue, S3 bucket or CloudFront distribution exists yet.

## Depends on
- Platform foundation from the E8 children: `platform-service` table (on-demand, PITR, Streams, GSI1-GSI3), HTTP API + shared Lambda authorizer (E8-S1, `infrastructure#6`), Verified Permissions policy store (E8-S3).
- E4-S7-INFRA
- E3-S3




---

## #189 — E4-S9-INFRA: Compartment inventory per apparatus

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/69 · **Wave:** 4

Deploy the merged compartment inventory handlers.

## Scope
- Routes: `GET /api/v1/apparatus/{unitId}/inventory`, `POST /api/v1/apparatus/{unitId}/inventory`, quantity update `/api/v1/apparatus/{unitId}/inventory/{itemId}` (method per handler).
- arm64 Lambda(s), not VPC-attached, log group from `ServiceLogGroup`: `src/services/apparatus-service/inventory-list/handler.ts`, `inventory-create/handler.ts`, `inventory-quantity/handler.ts`. Execution role: `dynamodb:PutItem/UpdateItem/GetItem/Query` on the platform table; `verifiedpermissions:IsAuthorizedWithToken`/`BatchIsAuthorizedWithToken` on the policy store; X-Ray write. Env: `PLATFORM_TABLE_NAME`, `VERIFIED_PERMISSIONS_POLICY_STORE_ID`.

## Acceptance criteria
- Given the three routes deployed, when an item is added and adjusted, then GET lists it grouped with the new quantity (AC1, AC2).

## Current state
- `boxalarm-infrastructure` origin/main has only `components/identity/*` (Cognito pool/clients) and `components/observability/*` (log groups, dashboards, X-Ray sampling for all 10 services). No DynamoDB table, HTTP API route, Lambda, EventBridge bus, SQS queue, S3 bucket or CloudFront distribution exists yet.
- Backend env: `inventory/config.ts` reads `PLATFORM_TABLE_NAME`.

## Depends on
- Platform foundation from the E8 children: `platform-service` table (on-demand, PITR, Streams, GSI1-GSI3), HTTP API + shared Lambda authorizer (E8-S1, `infrastructure#6`), Verified Permissions policy store (E8-S3).
- E4-S1-INFRA




---

## #190 — E4-S10-INFRA: Check-compliance reporting — what got checked, what didn't

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/70 · **Wave:** 6

Read-only compliance route.

## Scope
- Route: `GET /api/v1/apparatus/compliance`.
- arm64 Lambda(s), not VPC-attached, log group from `ServiceLogGroup`: the compliance handler E4-S10 backend adds. Execution role: `dynamodb:Query` on the platform table + `GSI3` (read-only); `verifiedpermissions:IsAuthorizedWithToken`/`BatchIsAuthorizedWithToken` on the policy store; X-Ray write. Env: `PLATFORM_TABLE_NAME`, `VERIFIED_PERMISSIONS_POLICY_STORE_ID`.

## Acceptance criteria
- Given an admin token and date range, when called, then the Lambda returns per-apparatus compliance (AC1).
- Given the role, when inspected, then it has no write actions.

## Current state
- `boxalarm-infrastructure` origin/main has only `components/identity/*` (Cognito pool/clients) and `components/observability/*` (log groups, dashboards, X-Ray sampling for all 10 services). No DynamoDB table, HTTP API route, Lambda, EventBridge bus, SQS queue, S3 bucket or CloudFront distribution exists yet.
- Backend: no compliance handler on main.
- DynamoDB index names are case-sensitive and backend main mixes `GSI1/GSI2/GSI3` (apparatus, hydrant, map, training, platform audit) with `gsi1/gsi2/gsi3` (inventory equipment, listInspections, personnel shifts). The table defines one spelling; the backend must be normalized to it before these routes work.

## Depends on
- Platform foundation from the E8 children: `platform-service` table (on-demand, PITR, Streams, GSI1-GSI3), HTTP API + shared Lambda authorizer (E8-S1, `infrastructure#6`), Verified Permissions policy store (E8-S3).
- E4-S3-INFRA




---

## #191 — E4-S11-INFRA: Equipment/asset registry with serial numbers, assignment, and location

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/71 · **Wave:** 3

Deploy the merged equipment registry handlers.

## Scope
- Routes: `GET`/`POST /api/v1/inventory/equipment`, `GET /api/v1/inventory/equipment/{assetId}`, `/api/v1/inventory/equipment/{assetId}/assignment`, `/api/v1/inventory/equipment/{assetId}/location` (methods per handler).
- arm64 Lambda(s), not VPC-attached, log group from `ServiceLogGroup`: `src/services/inventory-service/equipment/{create,list,get,assignment,location}/handler.ts` (+ `health/liveness`, `health/readiness`). Execution role: `dynamodb:TransactWriteItems/PutItem/UpdateItem/GetItem/Query` on the platform table + `gsi1`/`gsi3` index ARNs; `verifiedpermissions:IsAuthorizedWithToken`/`BatchIsAuthorizedWithToken` on the policy store; X-Ray write. Env: `PLATFORM_TABLE_NAME`, `VERIFIED_PERMISSIONS_POLICY_STORE_ID`.

## Acceptance criteria
- Given the routes deployed, when an asset is created, assigned and moved, then GET reflects each change (AC1-AC3).
- Given a non-admin token, when POST is called, then 403 (Cedar).

## Current state
- `boxalarm-infrastructure` origin/main has only `components/identity/*` (Cognito pool/clients) and `components/observability/*` (log groups, dashboards, X-Ray sampling for all 10 services). No DynamoDB table, HTTP API route, Lambda, EventBridge bus, SQS queue, S3 bucket or CloudFront distribution exists yet.
- Backend env: `lib/dynamoDb.ts` reads `PLATFORM_TABLE_NAME`; queries use lowercase `gsi1`/`gsi3`.
- DynamoDB index names are case-sensitive and backend main mixes `GSI1/GSI2/GSI3` (apparatus, hydrant, map, training, platform audit) with `gsi1/gsi2/gsi3` (inventory equipment, listInspections, personnel shifts). The table defines one spelling; the backend must be normalized to it before these routes work.

## Depends on
- Platform foundation from the E8 children: `platform-service` table (on-demand, PITR, Streams, GSI1-GSI3), HTTP API + shared Lambda authorizer (E8-S1, `infrastructure#6`), Verified Permissions policy store (E8-S3).




---

## #192 — E4-S12-INFRA: PPE assignment with sizes and NFPA service-life expiry alerting

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/72 · **Wave:** 7

PPE routes, daily PPE Expiry Scanner, and the inventory notify queue.

## Scope
- Routes: `GET /api/v1/inventory/ppe/{memberId}` and the PPE issue route E4-S12 backend defines.
- arm64 Lambda(s), not VPC-attached, log group from `ServiceLogGroup`: PPE handlers. Execution role: `dynamodb:PutItem/GetItem/Query` on the platform table + `GSI1`/`GSI2`; `verifiedpermissions:IsAuthorizedWithToken`/`BatchIsAuthorizedWithToken` on the policy store; X-Ray write. Env: `PLATFORM_TABLE_NAME`, `VERIFIED_PERMISSIONS_POLICY_STORE_ID`.
- PPE Expiry Scanner: EventBridge Scheduler daily -> scanner Lambda (GSI2 read; `OUTBOX_RECORD` for `ppe.expiry.due`, drained by E5-S2-INFRA's drain); error alarm.
- Bus rule `detail-type = ppe.expiry.due` -> `inventory-notify-queue` (standard SQS) + DLQ `maxReceiveCount: 5` -> notification-service consumer (E3-S3), NOTIF-ISO as E4-S4-INFRA.

## Acceptance criteria
- Given an item inside lead time, when the daily scan runs, then `ppe.expiry.due` reaches `inventory-notify-queue` (AC2).

## Current state
- `boxalarm-infrastructure` origin/main has only `components/identity/*` (Cognito pool/clients) and `components/observability/*` (log groups, dashboards, X-Ray sampling for all 10 services). No DynamoDB table, HTTP API route, Lambda, EventBridge bus, SQS queue, S3 bucket or CloudFront distribution exists yet.
- Backend: no PPE handler or scanner on main.

## Depends on
- Platform foundation from the E8 children: `platform-service` table (on-demand, PITR, Streams, GSI1-GSI3), HTTP API + shared Lambda authorizer (E8-S1, `infrastructure#6`), Verified Permissions policy store (E8-S3).
- E5-S2-INFRA (drain, bus)
- E3-S3




---

## #193 — E4-S13-INFRA: Consumable stock levels and reorder-threshold alerting

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/73 · **Wave:** 7

Consumables routes, scheduled stock scan, and the reorder rule.

## Scope
- Routes: `GET /api/v1/inventory/consumables` and the stock update route E4-S13 backend defines.
- arm64 Lambda(s), not VPC-attached, log group from `ServiceLogGroup`: consumables handlers. Execution role: `dynamodb:UpdateItem/GetItem/Query` on the platform table + `GSI3`; `verifiedpermissions:IsAuthorizedWithToken`/`BatchIsAuthorizedWithToken` on the policy store; X-Ray write. Env: `PLATFORM_TABLE_NAME`, `VERIFIED_PERMISSIONS_POLICY_STORE_ID`.
- Stock scan: EventBridge Scheduler daily -> scan Lambda (writes `OUTBOX_RECORD` for `inventory.reorder.due`).
- Bus rule `detail-type = inventory.reorder.due` -> `inventory-notify-queue` + DLQ (create if E4-S12-INFRA has not).

## Acceptance criteria
- Given an item at threshold, when the scan runs, then `inventory.reorder.due` with itemId/itemName/currentQty/reorderThreshold/deptId reaches the queue (AC2).

## Current state
- `boxalarm-infrastructure` origin/main has only `components/identity/*` (Cognito pool/clients) and `components/observability/*` (log groups, dashboards, X-Ray sampling for all 10 services). No DynamoDB table, HTTP API route, Lambda, EventBridge bus, SQS queue, S3 bucket or CloudFront distribution exists yet.
- Backend: no consumables handler or scan on main.

## Depends on
- Platform foundation from the E8 children: `platform-service` table (on-demand, PITR, Streams, GSI1-GSI3), HTTP API + shared Lambda authorizer (E8-S1, `infrastructure#6`), Verified Permissions policy store (E8-S3).
- E5-S2-INFRA
- E3-S3




---

## #194 — E4-S14-INFRA: Asset lifecycle: acquisition through retirement

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/74 · **Wave:** 4

Deploy the merged lifecycle handler.

## Scope
- Route: `PUT /api/v1/inventory/equipment/{assetId}/lifecycle`.
- arm64 Lambda(s), not VPC-attached, log group from `ServiceLogGroup`: `src/services/inventory-service/lifecycle/handler.ts`. Execution role: `dynamodb:UpdateItem/TransactWriteItems/GetItem` on the platform table; `verifiedpermissions:IsAuthorizedWithToken`/`BatchIsAuthorizedWithToken` on the policy store; X-Ray write. Env: `PLATFORM_TABLE_NAME`, `VERIFIED_PERMISSIONS_POLICY_STORE_ID`.

## Acceptance criteria
- Given an admin PUT to RETIRED, when it runs, then the asset's GSI1 assignment keys are removed (AC2).
- Given a non-admin token, when called, then 403 (AC3).

## Current state
- `boxalarm-infrastructure` origin/main has only `components/identity/*` (Cognito pool/clients) and `components/observability/*` (log groups, dashboards, X-Ray sampling for all 10 services). No DynamoDB table, HTTP API route, Lambda, EventBridge bus, SQS queue, S3 bucket or CloudFront distribution exists yet.
- Backend env: `lifecycle/repository.ts` reads `PLATFORM_TABLE_NAME`.

## Depends on
- Platform foundation from the E8 children: `platform-service` table (on-demand, PITR, Streams, GSI1-GSI3), HTTP API + shared Lambda authorizer (E8-S1, `infrastructure#6`), Verified Permissions policy store (E8-S3).
- E4-S11-INFRA




---

