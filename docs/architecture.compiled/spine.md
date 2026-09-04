# Architecture Spine: Boxalarm — Architecture (Fire Department Operations Platform)

## Service Inventory & Boundaries
- `alerting-service` — dispatch ingress, fan-out, escalation, receipts, self-test, canary, alert audit log — isolated life-safety plane, own DynamoDB table, own SNS FIFO topic/SQS FIFO queues, own IAM boundary (no read/write access to any other table).
- `platform-service` — Cognito triggers, department config, Verified Permissions policy admin, cross-service audit log sink, data export — shares the `platform-service` DynamoDB table with 7 other LOB services.
- `personnel-service` — roster, quals, attendance, LOSAP points, availability, duty shifts, open-shift signup — on `platform-service` table.
- `apparatus-service` — apparatus registry, check sheets, defects, OOS tracking, maintenance, SCBA, testing schedules, compartments — on `platform-service` table.
- `incident-service` — NERIS-native incident model, pre-population, guided completion, NERIS submission, submission status, search — own dedicated DynamoDB table.
- `training-service` — certifications, expiry alerting, drills, training hours, transcripts — on `platform-service` table.
- `reporting-service` — chief dashboard, LOSAP/ISO/grant reports, response-time analytics, CSV/PDF export — no primary store; queries purpose-built GSIs on `platform-service` table (v1; OpenSearch/OSI deferred on cost-floor grounds).
- `inspections-service` — occupancy, pre-incident plans, inspection/violation tracking, hydrants, map retrieval — on `platform-service` table.
- `inventory-service` — equipment/PPE registry, consumable stock, asset lifecycle — on `platform-service` table.
- `notification-service` — non-alert member/officer notification (cert expiry, defect routing, testing-due, PPE expiry, reorder thresholds, shift-coverage gaps); notification preferences, in-app inbox, digest batching — on `platform-service` table, LOB failure domain explicitly, shares no queue/concurrency/provider account with alerting.

10 service code boundaries; 3 physical DynamoDB tables (`alerting-service`, `incident-service`, `platform-service` — the latter shared by 8 services). Each service is Lambda-per-route under `src/services/<name>/` in the single `boxalarm-backend` repo; all Pulumi lives in `boxalarm-infrastructure`.

## Tech Stack Decisions
- Language: TypeScript / Node.js LTS, all 10 services (house default; no AI/ML workload).
- Compute: AWS Lambda, arm64, container image (multi-stage Alpine) or zip.
- Ingress: API Gateway **HTTP API** (not REST API) + custom Lambda authorizer — reconciled deviation from the house "no API Gateway" ruling; used purely for TLS/routing, no usage plans/API-key machinery; all JWT validation, rate limiting, routing logic stay in app code.
- Data: DynamoDB on-demand, 3 tables (not 10) — see Service Inventory.
- Search/reporting: v1 = DynamoDB GSIs only. OpenSearch via OSI deferred (cost-floor for a volunteer department); DynamoDB Streams on from day one on all 3 tables to allow later addition without a write-path change.
- Messaging: two transports, deliberately different — **SNS FIFO** (alerting only) → per-channel SQS FIFO + DLQs; **EventBridge** bus `boxalarm-{env}-platform-bus` (LOB only), rule-routed to per-consumer SQS + DLQ. EventBridge has no FIFO mode and is never used for alerting fan-out. Crossing between planes is one-way only (alerting → LOB via a narrow allow-list republish); LOB can never reach into alerting.
- Orchestration: Step Functions or EventBridge Scheduler one-time timers (escalation ladder, NERIS retry/backoff).
- Cache: ElastiCache Serverless (Valkey) — config/reference data and reporting aggregations only; explicitly a soft dependency; never on the alerting hot path.
- IaC: Pulumi, `boxalarm-infrastructure` repo exclusively owns all AWS resources.
- Identity: Amazon Cognito, single user pool per environment.
- Authorization: AWS Verified Permissions, Cedar policies encoding 6 roles (F2.7) and department scoping (F9.6). Fail-secure (503 on VP outage, never a defaulted allow) — except alerting-service's core fan-out/escalation hot path, which has no per-request authz decision.
- No self-hosted broker (no Kafka/RabbitMQ) — AWS-native only, pay-per-use.

## Naming Conventions
- API base path: `/api/v1/{service}/...`, JSON camelCase, RFC 7807 errors with `traceId`, contract-first OpenAPI per service.
- Resource naming is `boxalarm-{env}-*` everywhere. Any `moonaan-prod-*` name appearing anywhere in the source document is template boilerplate and must be read as `boxalarm-{env}-*`.
- Event naming: lowercase dotted `<domain>.<entity>.<past-tense-verb>` (e.g. `dispatch.alert.received`, `alerting.response.confirmed`, `personnel.member.updated`, `cert.expiry.due`, `apparatus.check.completed`, `neris.incident.submitted`). PascalCase shorthand appearing elsewhere in the source document is not the implementation form.
- DynamoDB key format: `ENTITY_TYPE#value` for `pk`/`sk`/`gsiNpk`/`gsiNsk`. `{deptId}` present in every table PK from day one (F9.6 tenancy seam), even with one department in operation.
- SNS FIFO topic: `boxalarm-{env}-alerting-topic.fifo`. EventBridge bus: `boxalarm-{env}-platform-bus`. The six per-domain SNS topics named elsewhere in the source (`*-training-topic`, `*-apparatus-topic`, `*-inventory-topic`, `*-neris-topic`, `*-scheduling-topic`, `*-personnel-topic`) are **superseded** by the single platform-bus with per-event-type rules; consumer queue names remain correct.
- SQS: per-channel FIFO queues for alerting (`alerting-push-queue.fifo`, `alerting-sms-queue.fifo`, `alerting-voice-queue.fifo`, `alerting-receipts-queue.fifo`), each with its own DLQ.

## Cross-Cutting Non-Negotiables

**Auth — CANONICAL, reflects the 2026-09-04 amendment. NO MFA, NO step-up re-authentication, NO session expiry anywhere in the system.**
- Cognito is the sole identity provider (OAuth2 Authorization Code + PKCE, no client secret in the mobile binary). `MfaConfiguration: OFF`, no role-conditional MFA, no enrollment flow, for every role including chief/admin.
- Access/ID token validity 1 hour; refresh token validity **3650 days** (Cognito's ceiling) on both native and web, no asymmetry. Silent background refresh only (`react-native-app-auth` on mobile, `oidc-client-ts` `automaticSilentRenew` on web) — first sign-in is the only interactive one. Refresh-token rotation enabled with a grace window.
- **No idle timeout, no periodic forced re-authentication, on either surface.**
- **No step-up re-authentication on any route, anywhere** — including `POST /platform/export` and destructive admin actions (bulk delete, records disposal). These are gated **solely** by a Cedar chief/admin role check via `IsAuthorizedWithToken`, fail-secure (503, never defaulted allow). A valid session on a chief/admin account is, by itself, sufficient for full data export or disposal.
- Compensating controls in place of expiry/step-up: Cognito global sign-out / refresh-token revocation on member status change (LOA, retired — via `personnel.member.updated`), per-device revocation from the admin console, unconditional per-invocation alarm on every `POST /platform/export`, off-hours privileged-activity alarms. Revocation, not expiry, is the kill switch — and who performs revocation and how fast is an open question (OQ-24).
- Centralized JWT validation: one Lambda authorizer in front of API Gateway (signature via JWKS, `client_id` audience check — not `aud` — issuer, expiration) via `aws-jwt-verify`.
- Vendor webhooks (CAD ingress, channel delivery receipts) authenticate by vendor signature/shared secret, never Cognito.
- NERIS auth is separate: `incident-service` holds its own OAuth2 client-credentials grant, credentials in Secrets Manager per environment.
- F9.1 credential recovery is a Cognito hosted self-service flow (email/SMS) — must never require a human support step.

**Alerting isolation invariant (IAM-enforced, not just documented).** No component of `alerting-service` performs a synchronous read/write against `platform-service` or `incident-service` at any point, ever. Fan-out reads only its own table's denormalized `MEMBER_ELIGIBILITY_SNAPSHOT` and `PRE_PLAN_COPY`. The `alerting-service` execution roles hold **no IAM permission** on the other two tables. The sole sanctioned exception: `POST /platform/export`'s dedicated read-only role, which has read access to all three tables (reverse direction only), Cedar chief/admin-gated, alarmed on every invocation.

**Exactly-once alerting key (CANONICAL).** `{dispatchId}#{memberId}#{channel}` — per-channel, never per-member alone. DynamoDB conditional put (`attribute_not_exists`) in the channel worker immediately before the provider send call is the enforced guarantee; SNS/SQS FIFO `MessageDeduplicationId` is a transport-layer optimization only (5-min window, not the enforced guarantee).

**Routing/dedup key on `channel`, never `channelTier`.** `channelTier` (`primary`|`escalation`) is escalation-state bookkeeping only. Push and SMS share tier `primary`; a tier-keyed dedup ID silently collapses the two into one send (SNS FIFO discards the duplicate — no error, no DLQ, no receipt), defeating the N1.2 parallel guarantee. Fan-out issues one publish per `{member, channel}` pair.

**Escalation ladder (CANONICAL).** Push + SMS fire in parallel at T+0 (both `channelTier=primary`); voice is the sole escalation tier at T+N, default N=75s, department-configurable (F9.3). Any other sequencing described elsewhere in the source is superseded.

**Event envelope (every event, every domain):** `eventId` (UUID, dedup key), `eventTime` (ISO-8601), `eventType` (`{domain}.{entity}.{verb}`, past tense), `source`, `correlationId` (the `dispatchId` for alerting), `schemaVersion` (semver), `payload` (domain-specific).

**Error envelope:** RFC 7807 problem-details with a `traceId` field on every API error response.

**Deployment topology:** AWS serverless, single region (U.S.-pinned per NERIS N6.1), single-tenant with `{deptId}` multi-tenant seam present in every partition key from day one. 4 repos: `boxalarm-ui` (RN app + web SPA + shared packages, build-only), `boxalarm-backend` (all Lambda code, build-only), `boxalarm-infrastructure` (all Pulumi, sole AWS-resource owner), `boxalarm-docs`. Never a monorepo, never per-service repos. No MFE shell/remote topology (single frontend team/release train) — one React web SPA, one React Native app (iOS+Android, one codebase, bare RN not Expo managed).

**Observability:** X-Ray active tracing on every Lambda, correlated per `{dispatchId}#{memberId}#{channel}` (diagnostic aid only — not the audit trail). CloudWatch structured JSON logs with `correlationId`/`service`. Alerting-specific CloudWatch alarms (fan-out p99 vs 5s N1.1 target, per-channel delivery-failure rate, canary failure, duplicate-delivery counter) are P0, page a human directly, kept on a separate dashboard from general LOB alarms. Every SQS queue has a paired DLQ (`maxReceiveCount: 3` alerting, `3–5` elsewhere) with a CloudWatch alarm on `ApproximateNumberOfMessagesVisible > 0`; alerting DLQ alarms page on-call immediately. No PII in logs.

**N1.7 is documented as NOT literally satisfied.** SNS FIFO topic, alerting DynamoDB table, fan-out Lambda, and AWS region are each an accepted single point of failure with no alternate path. Retained parallel tone-out paging (**N1.9**) is the compensating control and is therefore **not optional** — chaos testing is scoped to the channel layer only, never to topic/table/region.

**Endpoint auth model:** `Cognito` = end-user JWT via the shared Lambda authorizer; `Cognito(admin)` = authorizer + Verified Permissions check requiring chief/admin/officer role; `Vendor` = inbound webhook via vendor-specific signature/shared secret, not Cognito.

## Open Questions
- **OQ-1 (blocking, immediately).** CAD integration surface — vendor/product/protocol/delivery-mechanism for regional CAD dispatch all unknown. `DispatchIngressPort` designed with pluggable adapters; no adapter chosen. Owner: fire chief + platform operator.
- **OQ-2 (blocking, start this week — longest pole).** Regional dispatch authority approval for the CAD integration. Owner: fire chief.
- **OQ-3 (Wave 1).** SMS and voice vendor selection, unconfirmed — must be two distinct commercial vendors per N1.2, plus data-handling terms (no content retention beyond delivery confirmation, U.S.-only processing). Owner: platform operator.
- **OQ-4 (blocking, start this week).** Apple Critical Alerts entitlement ownership/timeline — unconfirmed, could gate N3.2; rejection would materially weaken the product. Owner: platform operator.
- **OQ-8 (Wave 1).** Canary cadence (2 min proposed, not confirmed) — trades detection speed against provider cost.
- **OQ-9 (before Wave 1 code).** Ratify the API Gateway house-standard-deviation reconciliation (HTTP API for TLS/routing only). Owner: Moonaan standards owner.
- **OQ-10–14 (backlog refinement).** Station alerting hardware; Chief360 migration scope/format; CT LOSAP statutory point rules; CT state fire reporting beyond NERIS; mutual aid / cross-department visibility.
- **OQ-15–17 (accepted deferrals, revisit at trigger).** No OpenSearch/CQRS in v1; several low-cardinality GSI partitions accepted at one-department scale; NERIS incident ID assumed minted once at alert time (verify against actual NERIS behavior).
- **OQ-18 (blocking, before Wave 1 ships).** Who carries the pager at 03:00 — alarm routing/escalation/on-call is otherwise undefined against the "no 24/7 staffed support" constraint.
- **OQ-19 (Wave 2).** CT/municipal records-retention schedule — the 7-year default is a considered guess, not a confirmed requirement.
- **OQ-20 (Wave 1, F1.8).** Mapping provider — unselected, was `[ASSUMED]` and previously untracked as a question.
- **OQ-21 (blocking, before Wave 1 ships).** Who operates the platform day to day, and what is the monthly run-cost ceiling — the "hard budget constraint" driving 4+ architecture decisions is unquantified and unowned.
- **OQ-22 (before N1.9 cutover).** Members without a capable smartphone — can SMS/voice serve as a primary path, or are they uncovered once tone-out retires? Policy decision, not technical.
- **OQ-23 (Wave 2).** NERIS Integration Partner vendor account — required before any production submission; lead time unknown.
- **OQ-24 (blocking, before Wave 1 ships).** Who revokes a compromised/lost session and how fast — revocation is now the *only* control that ends access (see Auth above), and no on-duty human is established (per OQ-18/OQ-21).
- Mobile OIDC library: **resolved** — `react-native-app-auth` (AppAuth, system-browser PKCE); ratify as a house-standard addition for RN, the credible-alternative set is empty.
- Chief360 data migration scope/format: unknown; backfill-only approach assumed, no live dual-write.
- Whether a `@moonaan` React Native shared component library exists: unconfirmed; native UI starts custom, token-driven.
- Native a11y automated CI check (no RN-equivalent of axe in the current stack): open, currently manual-only (VoiceOver/TalkBack per release).
- Native device-farm vendor for N3.7 real-device testing: unconfirmed (BrowserStack App Automate assumed as a placeholder).
- Chaos-testing tooling: unnamed (e.g. AWS FIS vs. custom harness), left to backend/eventing implementation.
- Offline conflict-resolution strategy (last-write-wins vs. explicit merge): not specified; test plan validates the property (deterministic, no silent loss), not a specific algorithm.

## Compiled Provenance
Source: /Users/zacharydemanche/Projects/boxalarm/docs/architecture.md (2410 lines, sha256 c5de1eac…)
Compiled: 2026-09-04 by sdlc plugin v2.12.0
