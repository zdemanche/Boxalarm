# Architecture Spine: Boxalarm — Architecture

## Service Inventory & Boundaries
- alerting-service — dispatch ingress (CAD email/signed-webhook/manual), fan-out, per-member channel escalation, department tone ladder, mutual-aid prompt, receipts, self-test, canary, alert audit — isolated life-safety plane: own DynamoDB table, own SNS FIFO topic, SQS FIFO queues + DLQs; no IAM to platform/incident tables
- platform-service — Cognito triggers, department config (incl. ALERT_RULES, CAD sources, NERIS entity), Verified Permissions admin, audit sink, data export, session revoke/reset — LOB plane, `platform` table
- personnel-service — roster, status, quals, attendance, LOSAP, availability mark-offs, duty shifts/claims, push-device writer (`writePushDevices`) — LOB, `platform` table
- apparatus-service — registry, checks, defects, OOS, maintenance, SCBA, tests, compartments, riding board (alerting-plane routes) — LOB, `platform` table
- incident-service — NERIS-native incident model, lock/submit/resubmit, submission status, search — own `incident` table
- training-service — certs, expiry, drills, hours, transcripts — LOB, `platform` table
- reporting-service — chief dashboard, LOSAP/ISO/grant/response/membership reports, export; no primary data — GSIs on `platform` table
- inspections-service — occupancies, pre-plans, inspections/violations, hydrants, map, archive — LOB, `platform` table
- inventory-service — equipment, PPE, consumables, lifecycle — LOB, `platform` table
- notification-service — non-alert notifications (inbox, preferences, digests); LOB failure domain; paths NOT under /api/v1 — `platform` table
- web-console — single React SPA for officer/chief/training/apparatus/admin (15 routes)
- mobile-app — bare React Native iOS+Android, native Swift/Kotlin alert layer, offline-first
- ui-shared-packages — @boxalarm/core, design-tokens, i18n
- infrastructure — all Pulumi: HTTP API, authorizers, CAD REST API, messaging, IAM boundaries, alarms, CodeDeploy
- testing-strategy — tiered test plan, Playwright/axe, CI gates
- Approved to build, NOT yet designed (no sheet): assist-service (Bedrock/Transcribe; denied to alerting role), live service, presence plane. Deferred: `station` channel, cross-department person record, public unauthenticated writes, CT permits/fees.

## Tech Stack Decisions
- TypeScript/Node LTS for all services (no AI workload; assist-service excepted); Lambda arm64 (zip or Alpine container) — pay-per-use under hard volunteer-budget constraint.
- API Gateway HTTP API (not REST) + custom Lambda authorizer; exceptions: CAD webhook own REST API with per-source API keys; per-route stage throttles on alerting routes.
- DynamoDB on-demand, PITR on, Streams on; THREE tables (alerting, incident, platform — 8 services share platform). No OpenSearch/CQRS in v1 (cost floor); GSIs per access pattern.
- Messaging: alerting = SNS FIFO `boxalarm-{env}-alerting-topic.fifo` -> SQS FIFO per channel + DLQs; LOB = EventBridge `boxalarm-{env}-platform-bus` rule-routed to SQS+DLQ; EventBridge Scheduler one-time timers; outbox pattern. No Kafka/RabbitMQ.
- Step Functions/Scheduler for timers; ElastiCache Serverless Valkey for config/schema/dashboard cache only (soft dependency, ~$40-50 floor flagged); S3 for attachments.
- Pulumi (IaC); Cognito single pool/env; Verified Permissions (Cedar) for authz; us-east-1 U.S.-pinned (N6.1); CloudFront ruled out (N6.1) — S3 presigned URLs.
- Frontend: React web SPA + bare React Native (New Architecture); TanStack Query, jotai, react-router-dom, react-navigation; oidc-client-ts (web), react-native-app-auth (mobile, ratified); op-sqlite or WatermelonDB; no MFE, no Nx/Turborepo.
- Testing: Vitest, Playwright + @axe-core/playwright, XCTest, JUnit/Espresso, MSW.

## Naming Conventions
- Endpoints `/api/v1/{service}/...`, JSON camelCase, RFC 7807 errors with `traceId`; health at `/api/v1/{service}/health/liveness|readiness`. notification-service is the exception (`/notifications...`, canonical per Backend §1.1).
- Events `{domain}.{entity}.{past-verb}` lowercase dotted; `domain` = owning service short name; PascalCase names never appear in code/config/rules. Renamed: `dispatch.alert.received`->`alerting.dispatch.received`, `cert.expiry.due`->`training.expiry.due`, `ppe.expiry.due`->`inventory.expiry.due`.
- Resources `boxalarm-{env}-*` (read any `moonaan-prod-*` as such). Repos: boxalarm-ui, -backend, -infrastructure, -docs (never monorepo per source).
- Keys: `ENTITY_TYPE#value`, `pk`/`sk`/`gsiNpk`/`gsiNsk`; `{deptId}` in every PK (tenancy seam F9.6). S3 `{deptId}/{entityType}/{entityId}/{filename}`.
- Services under `src/services/<name>/`.

## Cross-Cutting Non-Negotiables
- Alerting isolation (N1.5): alerting-service never reads/writes platform or incident tables; denormalized copies (MEMBER_ELIGIBILITY_SNAPSHOT, PRE_PLAN_COPY, HYDRANT_COPY, ALERT_RULES_COPY, CAD_INGRESS_COPY) event-fed; enforced by IAM boundary. Bounded identity-path exceptions (authorizer revocation read, Pre Token Generation) fail open. No cache on alert hot path.
- EXACTLY-ONCE KEY: `{dispatchId}#{toneSequence}#{memberId}#{channel}`, conditional put `attribute_not_exists`; receipt `sk = RECEIPT#{memberId}#{channel}#{toneSequence}`; immutable per-channel-per-tone receipts. 2-segment and 3-segment (no toneSequence) forms are silent-suppression defects. FIFO `MessageDeduplicationId = hash(dispatchId,toneSequence,memberId,channel)` is transport optimization only; `MessageGroupId = dispatchId`. NEVER BatchWriteItem for conditional writes.
- `channelTier` (primary|escalation) is bookkeeping only — never routing or dedup. Routing/dedup key on `channel`. One publish per {member, channel, toneSequence}. Push+SMS parallel at T+0, voice sole escalation at T+N (default 75s).
- `toneSequence` is a literal in each schedule payload (2 at T+180s, 3 at T+360s), never computed at fire time. Audience of every tone = full eligible set, never filtered by ackStatus.
- Event envelope on every event: eventId, eventTime, eventType, source, correlationId, schemaVersion, payload. Outbox pattern for writes that raise events; consumer dedup on eventId (48h).
- Auth: Cognito sole IdP; NO MFA, NO step-up, NO session timeout (MfaConfiguration OFF, access/ID 1h, refresh 3650d, silent renew); revocation (marker, ~30s) is the only kill switch. Authorizer checks signature/`client_id`/issuer/exp via aws-jwt-verify + revocation marker. Authz via Verified Permissions (`IsAuthorizedWithToken`; `BatchIsAuthorizedWithToken` for lists); fail-secure 503, except alerting fan-out pipeline. Vendor webhooks authenticate by signature, not Cognito. Self sign-up off.
- Fail-open authorizer set == `ALERTING_PLANE_ROUTES` exactly; officer alerting reads fail closed; pinned by `infrastructure/test/api/fail-open-contract.test.ts`.
- Observability: structured JSON logs with `correlationId`+`service`; no PII in logs; W3C traceparent; X-Ray on all Lambdas; alerting alarms (fan-out p99 5s, delivery failure, canary, DLQ>0, `ToneFiredZeroReceipts`) are P0 and page directly; canary uses the real ingress path, publishes straight to CloudWatch.
- Deployment: no maintenance window ever for alerting; versioned alias + CodeDeploy canary shift gated by N1.6 canary and N8.2 alarms as rollback triggers.
- DLQ on every queue: maxReceiveCount 3 alerting, 5 elsewhere; visibility timeout >= 2x consumer timeout.
- Fire-only, no PHI/EMS/ePCR; NERIS-native (no NFIRS); NERIS never PROD before N6.2 check; dev/prod strictly separated (N6.4); mandatory per-environment User-Agent; U.S. residency.
- Retention: no TTL on evidentiary entities (receipts, escalations, dispatches, responses, tone/mutual-aid, NERIS attempts, incidents, audit); archival by export job. N1.9 retained tone-out paging is NOT optional (compensating control for non-satisfied N1.7).
- Sensitive-data: PII markers per Data Model §3.5; INCIDENT_SECONDARY readable by affected member/chief/safety officer only.

## Open Questions
- OQ-1 CAD feed: adapters built (SES email, signed webhook); which feed the county sends still open. OQ-2 regional dispatch authority approval (longest pole). OQ-3 SMS/voice vendors unsigned (recommended Twilio SMS + AWS End User Messaging Voice; push = direct APNs/FCM decided). OQ-4 Apple Critical Alerts entitlement (filing directed, owner/status to confirm). OQ-8 canary cadence (2 min proposed). OQ-9 API Gateway deviation ratification (grown by CAD REST API + per-route throttles). OQ-10..14 station hardware, Chief360 migration, CT LOSAP, CT reporting, mutual aid. OQ-15..17 accepted deferrals (no OpenSearch; low-cardinality GSIs; NERIS ID minted once at alert time).
- OQ-18 who carries the pager at 03:00. OQ-19 CT/municipal retention schedule (7-year default). OQ-20 mapping provider [ASSUMED]. OQ-21 operator + run-cost ceiling. OQ-22 members without capable smartphone. OQ-23 NERIS Integration Partner account (whole NERIS loop unverified against live account). OQ-24 who revokes sessions and how fast (mechanism exists; who is on duty open). OQ-25 who may halt tone ladder.
- [ASSUMED]: CAD vendor/protocol, SMS/voice vendor, mapping provider, CT reporting, Chief360 export. Open: ElastiCache floor cost vs Lambda-local cache; RN a11y CI tooling; @moonaan RN component lib; device-farm vendor; chaos tooling; offline conflict strategy; tightening personnel status route to ADMIN-for-protected-targets; NERIS entity row sharing bare DEPT partition (known gap).
- Designed-not-built: `retoneRespondingMembers`, `voiceEscalatesPerTone`, `callTypeOverrides`, `haltCancelsPendingVoice` are NOT carried by ALERT_RULES_COPY; ALERT_RULES `requiredQuals` validator is an unbuilt obligation; contract-first OpenAPI unmet; endpoint table not exhaustive (route registrations in `infrastructure/components/api/http-api.ts` authoritative).

## Compiled Provenance
Source: /Users/benjaminrussell/Desktop/Firehouse/Boxalarm-monorepo/.worktrees/member-roles/docs/architecture.md (2840 lines, sha256 af877a47…)
Compiled: 2026-10-02 by sdlc plugin v2.16.0
