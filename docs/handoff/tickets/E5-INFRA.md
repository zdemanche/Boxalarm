# E5-INFRA: Deploy the inspections-service (occupancies, pre-plans, hydrants, inspections, map, field capture) and the pre-plan/hydrant alerting-plane copy

**Key:** E5-INFRA
**Story:** E5-S1..E5-S8 infrastructure children
**Directory:** `infrastructure/`
**Issues:** #195, #196, #197, #198, #199, #200, #201, #202

Every E5 backend handler already exists on main under `backend/src/services/inspections-service/` and `backend/src/services/alerting-service/prePlan/`, and the web UI for them is built — but **nothing is deployed**: `infrastructure/` has no inspections-service Lambda, route, role, bucket, or queue. This run deploys all of it. #202 is already reconciled onto the existing `GET /api/v1/alerting/dispatches/{dispatchId}` route (`getDispatchHandler.ts` embeds the pre-plan copy); for #202 only verify that and do not add a duplicate route. #198's copy consumers (`prePlanCopyHandler`, `hydrantCopyHandler`) run under the **alerting-service** IAM boundary: queue + DLQ + alarm fed by a platform-bus rule on `inspections.preplan.updated` / `inspections.hydrant.updated`.

## Decision (answers the prior run's STOP: decision-open-ac3)

`infrastructure/components/shared/lambda-code.ts` deploys every Lambda with `LAMBDA_HANDLER = "index.handler"`, but some inspections-service handler files (e.g. `occupancy/handler.ts`, which exports only `createOccupancyHandler`/`getOccupancyHandler`/`updateOccupancyHandler`) have no `handler` export. **Decision: a one-purpose backend exception is granted.** For every inspections-service (and alerting-service prePlan) handler this run deploys that lacks the entry shape `lambda-code.ts` expects, add a thin entry file under `backend/src/services/inspections-service/` (and the matching `backend/scripts/lambda-manifest.mjs` entry) that only re-exports the existing function as `handler` — one entry per route handler, **no logic changes**, with a Vitest check that each deployed entry resolves to a function. Nothing else in `backend/` may change. Do not split #195 out; deploy occupancy in this run.

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

## #195 — E5-S1-INFRA: Occupancy records: create, view, edit

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/75 · **Wave:** 3

Deploy the merged occupancy handler.

## Scope
- Routes: `GET`/`POST /api/v1/inspections/occupancies`, `GET`/`PUT /api/v1/inspections/occupancies/{id}` -> one Lambda.
- arm64 Lambda, not VPC-attached: `src/services/inspections-service/occupancy/handler.ts` (+ `health/handler.ts`). Role: `dynamodb:TransactWriteItems/PutItem/UpdateItem/GetItem/Query` on the platform table + `GSI3` (writes `AUDIT_LOG_ENTRY` in the same transaction); `verifiedpermissions:IsAuthorizedWithToken`.
- Env: `OCCUPANCY_TABLE_NAME` = platform table name, `VERIFIED_PERMISSIONS_POLICY_STORE_ID`.

## Acceptance criteria
- Given an admin edit, when it runs, then the occupancy update and its `AUDIT_LOG_ENTRY` commit together (AC3).
- Given a member without write permission, when POST/PUT is called, then 403 (AC4).

## Current state
- `boxalarm-infrastructure` origin/main has only `components/identity/*` (Cognito pool/clients) and `components/observability/*` (log groups, dashboards, X-Ray sampling for all 10 services). No DynamoDB table, HTTP API route, Lambda, EventBridge bus, SQS queue, S3 bucket or CloudFront distribution exists yet.
- Backend inconsistency: `occupancy/config.ts` reads `OCCUPANCY_TABLE_NAME` while every other inspections handler reads `PLATFORM_TABLE_NAME` for the same table; set both or normalize the backend.

## Depends on
- Platform foundation from the E8 children: `platform-service` table (on-demand, PITR, Streams, GSI1-GSI3), HTTP API + shared Lambda authorizer (E8-S1, `infrastructure#6`), Verified Permissions policy store (E8-S3).




---

## #196 — E5-S2-INFRA: Pre-incident plans with attachments, site diagrams, and utility shutoffs

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/76 · **Wave:** 4

Pre-plan routes, the platform-assets bucket + signed-URL CloudFront, and the platform-table outbox drain to the bus.

## Scope
- Routes: `GET`/`PUT /api/v1/inspections/occupancies/{id}/pre-plan` -> `getPrePlanHandler.ts`, `putPrePlanHandler.ts`; roles: platform table `TransactWriteItems/GetItem/Query`, `secretsmanager:GetSecretValue` on the signing-key secret, `verifiedpermissions:IsAuthorizedWithToken`.
- S3 `nichols-boxalarm-platform-assets` (per-stack suffix, bucket names are global): Block Public Access, SSE-S3, versioning off, abort multipart 7d, Intelligent-Tiering with IA at 60d, U.S. region.
- CloudFront distribution over the bucket with OAC (GET + PUT), trusted key group (public key), no caching on signed paths; private key in Secrets Manager.
- Env on asset-signing Lambdas: `PLATFORM_ASSETS_BUCKET_NAME`, `PLATFORM_ASSETS_CLOUDFRONT_DOMAIN`, `PLATFORM_ASSETS_CLOUDFRONT_KEY_PAIR_ID`, `PLATFORM_ASSETS_CLOUDFRONT_PRIVATE_KEY_SECRET_ID`, `PLATFORM_TABLE_NAME`.
- `boxalarm-{env}-platform-bus` EventBridge bus (if not already provisioned).
- Outbox drain: `src/services/inspections-service/outboxDrainHandler.ts` on the platform table stream, filter `NewImage.entityType = OUTBOX_RECORD`, `ReportBatchItemFailures`, bisect on error; role `events:PutEvents` on the bus only; env `PLATFORM_EVENT_BUS_NAME`. The handler is service-agnostic, so this is the single drain for all `@boxalarm/outbox` producers.

## Acceptance criteria
- Given a PUT with files, when the returned URL is used within 10 minutes under `{deptId}/PRE_PLAN/{prePlanId}/`, then upload succeeds; any other prefix or a direct S3 URL is denied (AC2).
- Given a pre-plan write, when the outbox record streams, then `inspections.preplan.updated` is on the bus (AC4).
- Given the bucket, when checked by E8-S10's residency assertion, then it is U.S.-region with public access blocked.

## Current state
- `boxalarm-infrastructure` origin/main has only `components/identity/*` (Cognito pool/clients) and `components/observability/*` (log groups, dashboards, X-Ray sampling for all 10 services). No DynamoDB table, HTTP API route, Lambda, EventBridge bus, SQS queue, S3 bucket or CloudFront distribution exists yet.
- Architecture pins CloudFront signed URLs while infra CLAUDE.md says "no global edge": objects stay in the U.S. bucket; E8-S10's residency check must allow this CloudFront use explicitly.

## Depends on
- Platform foundation from the E8 children: `platform-service` table (on-demand, PITR, Streams, GSI1-GSI3), HTTP API + shared Lambda authorizer (E8-S1, `infrastructure#6`), Verified Permissions policy store (E8-S3).
- E5-S1-INFRA
- E8-S10 (residency assertion)




---

## #197 — E5-S3-INFRA: Hydrant registry: location, size, flow, last test, out-of-service

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/77 · **Wave:** 3

Deploy the merged hydrant handlers.

## Scope
- Routes: `GET`/`POST /api/v1/inspections/hydrants`, `PUT /api/v1/inspections/hydrants/{hydrantId}`.
- arm64 Lambda(s), not VPC-attached, log group from `ServiceLogGroup`: `src/services/inspections-service/hydrant/listHydrantsHandler.ts`, `createHydrantHandler.ts`, `updateHydrantHandler.ts`. Execution role: `dynamodb:TransactWriteItems/PutItem/UpdateItem/GetItem/Query` on the platform table + `GSI2`/`GSI3`; `verifiedpermissions:IsAuthorizedWithToken`/`BatchIsAuthorizedWithToken` on the policy store; X-Ray write. Env: `PLATFORM_TABLE_NAME`, `VERIFIED_PERMISSIONS_POLICY_STORE_ID`.

## Acceptance criteria
- Given a hydrant update, when it runs, then the hydrant and its outbox item commit in one transaction (AC2).
- Given `GET` with a due month, when called, then the GSI2 due query returns hydrants in the window (AC4).

## Current state
- `boxalarm-infrastructure` origin/main has only `components/identity/*` (Cognito pool/clients) and `components/observability/*` (log groups, dashboards, X-Ray sampling for all 10 services). No DynamoDB table, HTTP API route, Lambda, EventBridge bus, SQS queue, S3 bucket or CloudFront distribution exists yet.
- Backend defect: `hydrantRepository.ts` writes outbox items with `entityType: 'OUTBOX_EVENT'`, but `outboxDrainHandler.ts` publishes only `OUTBOX_RECORD`. `inspections.hydrant.updated` is never published. Fix in backend (`@boxalarm/outbox`); do not widen the stream filter to hide it.
- DynamoDB index names are case-sensitive and backend main mixes `GSI1/GSI2/GSI3` (apparatus, hydrant, map, training, platform audit) with `gsi1/gsi2/gsi3` (inventory equipment, listInspections, personnel shifts). The table defines one spelling; the backend must be normalized to it before these routes work.

## Depends on
- Platform foundation from the E8 children: `platform-service` table (on-demand, PITR, Streams, GSI1-GSI3), HTTP API + shared Lambda authorizer (E8-S1, `infrastructure#6`), Verified Permissions policy store (E8-S3).
- E5-S2-INFRA (drain, bus)




---

## #198 — E5-S4-INFRA: Publish inspections.preplan.updated and inspections.hydrant.updated to the alerting-plane copy

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/78 · **Wave:** 5

The LOB-to-alerting copy queue and a PRE_PLAN_COPY consumer whose IAM boundary proves isolation.

## Scope
- Bus rules on `detail-type` `inspections.preplan.updated` and `inspections.hydrant.updated` -> `preplan-copy-queue` (standard SQS) + DLQ, `maxReceiveCount: 3`, DLQ alarm. Name follows the `alert-rules-copy-queue` precedent; this is the one sanctioned inward direction.
- Consumer Lambda in the alerting-service stack: arm64, **not VPC-attached**, env `ALERTING_TABLE_NAME`. Role: `sqs:ReceiveMessage/DeleteMessage/GetQueueAttributes` on `preplan-copy-queue`; `dynamodb:PutItem/UpdateItem/GetItem/Query` on the alerting table only (PRE_PLAN_COPY + EVENT_DEDUP); `kms:Decrypt/GenerateDataKey` on the alerting CMK.
- IAM policy test in `test/`: the alerting-service roles have no `dynamodb:*` on the platform or incident table ARNs.
- No change to `messaging-alerting.ts`: the SNS FIFO topic, per-channel queues and `channel` filters are untouched (docs#11 checklist stays with E1).

## Acceptance criteria
- Given a `inspections.preplan.updated` event on the bus, when the consumer runs, then a PRE_PLAN_COPY item is written in the alerting table (AC1).
- Given a hydrant update, when consumed, then the affected copy's nearestHydrants is rewritten from the payload (AC2).
- Given the IAM policy test, when it runs in CI, then alerting-service has no read/write on platform or incident tables (AC3).
- Given a copy write, when snapshotUpdatedAt vs. eventTime is emitted as an EMF metric, then it shows on the alerting-service dashboard (AC4, no alarm).

## Current state
- `boxalarm-infrastructure` origin/main has only `components/identity/*` (Cognito pool/clients) and `components/observability/*` (log groups, dashboards, X-Ray sampling for all 10 services). No DynamoDB table, HTTP API route, Lambda, EventBridge bus, SQS queue, S3 bucket or CloudFront distribution exists yet.
- Backend: no PRE_PLAN_COPY consumer in `src/services/alerting-service/` yet; precedent `eligibility/consumer.ts` reads `ALERTING_TABLE_NAME` (while `dispatches/dynamoClient.ts` reads `ALERTING_DISPATCHES_TABLE_NAME` for the same table).
- Chain is broken upstream today: hydrant outbox items are `OUTBOX_EVENT` and never drain (see E5-S3-INFRA).

## Depends on
- E1-S1-INFRA (alerting table, CMK)
- E5-S2-INFRA (bus, outbox drain)
- E5-S3 backend outbox fix
- boxalarm-docs#11 (read first; no channel-routing change here)




---

## #199 — E5-S5-INFRA: Inspection scheduling, conduct, and violation tracking

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/79 · **Wave:** 4

Deploy the merged inspection handlers.

## Scope
- Routes: `GET /api/v1/inspections`, `POST /api/v1/inspections` (schedule/conduct; method split per `recordInspection/handler.ts`).
- arm64 Lambda(s), not VPC-attached, log group from `ServiceLogGroup`: `src/services/inspections-service/listInspections/handler.ts`, `recordInspection/handler.ts` (+ `healthLiveness`/`healthReadiness`). Execution role: `dynamodb:PutItem/UpdateItem/GetItem/Query` on the platform table + `gsi2`; `verifiedpermissions:IsAuthorizedWithToken`/`BatchIsAuthorizedWithToken` on the policy store; X-Ray write. Env: `PLATFORM_TABLE_NAME`, `VERIFIED_PERMISSIONS_POLICY_STORE_ID`.

## Acceptance criteria
- Given scheduled inspections in the window, when GET runs, then the GSI2 month-bucket query returns them (AC4).

## Current state
- `boxalarm-infrastructure` origin/main has only `components/identity/*` (Cognito pool/clients) and `components/observability/*` (log groups, dashboards, X-Ray sampling for all 10 services). No DynamoDB table, HTTP API route, Lambda, EventBridge bus, SQS queue, S3 bucket or CloudFront distribution exists yet.
- Backend env: `dynamoClient.ts` reads `PLATFORM_TABLE_NAME`; `listInspections` queries lowercase `gsi2` while `hydrantRepository` queries `GSI2`.
- DynamoDB index names are case-sensitive and backend main mixes `GSI1/GSI2/GSI3` (apparatus, hydrant, map, training, platform audit) with `gsi1/gsi2/gsi3` (inventory equipment, listInspections, personnel shifts). The table defines one spelling; the backend must be normalized to it before these routes work.

## Depends on
- Platform foundation from the E8 children: `platform-service` table (on-demand, PITR, Streams, GSI1-GSI3), HTTP API + shared Lambda authorizer (E8-S1, `infrastructure#6`), Verified Permissions policy store (E8-S3).
- E5-S1-INFRA




---

## #200 — E5-S6-INFRA: Map-based retrieval of occupancies and hydrants

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/80 · **Wave:** 4

Deploy the merged map handler.

## Scope
- Route: `GET /api/v1/inspections/map`.
- arm64 Lambda(s), not VPC-attached, log group from `ServiceLogGroup`: `src/services/inspections-service/map/handler.ts`. Execution role: `dynamodb:Query` on the platform table `GSI3` (read-only); `verifiedpermissions:IsAuthorizedWithToken`/`BatchIsAuthorizedWithToken` on the policy store; X-Ray write. Env: `PLATFORM_TABLE_NAME`, `VERIFIED_PERMISSIONS_POLICY_STORE_ID`.

## Acceptance criteria
- Given a bbox spanning several geohash5 cells, when called, then the Lambda issues one GSI3 query per cell (AC1).
- Given the role, when inspected, then it has no write actions.

## Current state
- `boxalarm-infrastructure` origin/main has only `components/identity/*` (Cognito pool/clients) and `components/observability/*` (log groups, dashboards, X-Ray sampling for all 10 services). No DynamoDB table, HTTP API route, Lambda, EventBridge bus, SQS queue, S3 bucket or CloudFront distribution exists yet.
- Backend env: `map/dynamoClient.ts` reads `PLATFORM_TABLE_NAME`.

## Depends on
- Platform foundation from the E8 children: `platform-service` table (on-demand, PITR, Streams, GSI1-GSI3), HTTP API + shared Lambda authorizer (E8-S1, `infrastructure#6`), Verified Permissions policy store (E8-S3).
- E5-S1-INFRA
- E5-S3-INFRA




---

## #201 — E5-S7-INFRA: Mobile field capture with photos, offline-tolerant

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/81 · **Wave:** 5

Field-capture route with signed-URL access for occupancy and inspection photo prefixes.

## Scope
- Route: `POST /api/v1/inspections/field-capture`.
- arm64 Lambda(s), not VPC-attached, log group from `ServiceLogGroup`: the field-capture handler E5-S7 backend adds. Execution role: `dynamodb:TransactWriteItems/PutItem/UpdateItem/GetItem` on the platform table (idempotent conditional put); `verifiedpermissions:IsAuthorizedWithToken`/`BatchIsAuthorizedWithToken` on the policy store; X-Ray write. Env: `PLATFORM_TABLE_NAME`, `VERIFIED_PERMISSIONS_POLICY_STORE_ID`. Plus `secretsmanager:GetSecretValue` on the signing-key secret and the `PLATFORM_ASSETS_*` env vars.
- Reuse E5-S2-INFRA's bucket/CloudFront; no new storage.

## Acceptance criteria
- Given a retried push with the same idempotency key, when the Lambda runs twice, then one submission is recorded (AC2).
- Given a signed upload URL for `{deptId}/INSPECTION_RECORD/{id}/`, when used within 10 minutes, then upload succeeds; other prefixes fail (AC3).

## Current state
- `boxalarm-infrastructure` origin/main has only `components/identity/*` (Cognito pool/clients) and `components/observability/*` (log groups, dashboards, X-Ray sampling for all 10 services). No DynamoDB table, HTTP API route, Lambda, EventBridge bus, SQS queue, S3 bucket or CloudFront distribution exists yet.
- Backend: no field-capture handler on main.

## Depends on
- Platform foundation from the E8 children: `platform-service` table (on-demand, PITR, Streams, GSI1-GSI3), HTTP API + shared Lambda authorizer (E8-S1, `infrastructure#6`), Verified Permissions policy store (E8-S3).
- E5-S2-INFRA
- E5-S5-INFRA




---

## #202 — E5-S8-INFRA: Pre-plan and hydrant panel inside an active alert

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/82 · **Wave:** 7

Alerting-plane read route for PRE_PLAN_COPY, isolated from the LOB failure domain.

## Scope
- Route: the pre-plan read route E5-S8 backend adds under `/api/v1/alerting/dispatches/{dispatchId}/` (the alerting fact sheet lists none today).
- Lambda in the alerting-service stack: arm64, **not VPC-attached**, env `ALERTING_TABLE_NAME`. Role: `dynamodb:GetItem/Query` on the alerting table only, `kms:Decrypt` on the alerting CMK, `verifiedpermissions:IsAuthorizedWithToken`.
- Extend E5-S4-INFRA's IAM policy test to this role: no platform/incident table access.
- No shared reserved concurrency or queue with inspections-service, so the AC4 chaos test (saturate inspections/platform) cannot starve it.

## Acceptance criteria
- Given the deployed route, when called for a dispatch with a copy, then one alerting-table Query serves it (AC1, AC2).
- Given the IAM policy test, when run, then this role has no platform/incident table permission (AC4, N1.5).
- Given inspections-service Lambdas throttled in a chaos run, when the panel route is hit, then latency and success are unchanged (AC4).

## Current state
- `boxalarm-infrastructure` origin/main has only `components/identity/*` (Cognito pool/clients) and `components/observability/*` (log groups, dashboards, X-Ray sampling for all 10 services). No DynamoDB table, HTTP API route, Lambda, EventBridge bus, SQS queue, S3 bucket or CloudFront distribution exists yet.
- Backend: no pre-plan read handler in `src/services/alerting-service/` yet.

## Depends on
- E5-S4-INFRA
- E1-S1-INFRA (alerting table, CMK)
- E1-S6 backend route




---

