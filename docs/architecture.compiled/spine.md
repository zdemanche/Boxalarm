# Architecture Spine: Boxalarm — Architecture

## Service Inventory & Boundaries
Two planes: a life-safety **alerting plane** (isolated) and a **line-of-business (LOB) plane**. 10 backend services (one repo, `src/services/<name>/`), 3 DynamoDB tables, plus 2 client surfaces and infra. Slugs in parentheses.
- alerting-service (`alerting-service`) — CAD ingress, fan-out, per-member channel escalation, dept tone ladder (F1.12–F1.14), mutual-aid prompt, receipts, self-test, canary, alert audit — own table, own SNS FIFO topic, own SQS FIFO queues+DLQs; no sync read/write of platform/incident tables (IAM-enforced).
- platform-service (`platform-service`) — Cognito triggers, dept config, Verified Permissions admin, audit sink, data export, session revocation, CAD source config, NERIS entity sync — `platform-service` table.
- personnel-service (`personnel-service`) — roster, quals, attendance, LOSAP, availability mark-offs, duty shifts — platform table.
- apparatus-service (`apparatus-service`) — apparatus, check sheets, defects, OOS, maintenance, SCBA, testing, compartments, riding board (alerting-plane routes) — platform table.
- incident-service (`incident-service`) — NERIS-native incidents, guided completion, lock/submit/resubmit, submission status, search — own table.
- training-service (`training-service`) — certs, expiry, drills, hours, transcripts — platform table.
- reporting-service (`reporting-service`) — no primary data; dashboard/LOSAP/ISO/grant/response-time reports, export — GSIs on platform table.
- inspections-service (`inspections-service`) — occupancies, pre-plans, inspections/violations, hydrants, map — platform table.
- inventory-service (`inventory-service`) — equipment, PPE, consumables, lifecycle — platform table.
- notification-service (`notification-service`) — NON-alert notifications (inbox, prefs, digests, push non-critical channel + email) — platform table; LOB failure domain, shares nothing with alerting.
- web-spa (`web-spa`) — React officer/admin SPA (`apps/web`). mobile-app (`mobile-app`) — bare React Native iOS+Android (`apps/mobile`) with native Swift/Kotlin alert layer. Shared pkgs `@boxalarm/core|design-tokens|i18n`.
- infrastructure (`infrastructure`) — Pulumi: API GW, authorizers, Cognito, messaging, CodeDeploy alias rollout, S3, alarms.

## Tech Stack Decisions
TypeScript/Node LTS for all 10 services (assist-service amendment: language its own design). Lambda arm64 (Alpine container only if needed). API Gateway HTTP API + custom Lambda authorizer (cheapest; JWT/rate-limit in app code; exceptions: CAD webhook REST API w/ per-source API keys, per-route stage throttles). DynamoDB on-demand, PITR on, Streams on, 3 tables (alerting, incident, platform). No OpenSearch/CQRS v1 (cost floor; deferred, trigger in Data Model §1). SNS FIFO (alerting) + EventBridge bus `boxalarm-{env}-platform-bus` (LOB) + SQS+DLQ; EventBridge Scheduler/Step Functions for timers. Valkey (ElastiCache Serverless) LOB config/reference/dashboard cache only, soft dependency, never alerting. Pulumi IaC, AWS us-east-1 (U.S.-pinned; no CloudFront, N6.1). Cognito single pool/env + AWS Verified Permissions (Cedar). Frontend: React web SPA + bare React Native (New Arch), TanStack Query, jotai, i18next; no MFE; no Expo managed. No Kafka/RabbitMQ. Push = direct APNs/FCM; SMS/voice vendors unselected (must differ from each other).

## Naming Conventions
- Resources `boxalarm-{env}-*` (any `moonaan-prod-*` is template boilerplate). SNS: `boxalarm-{env}-alerting-topic.fifo`; bus `boxalarm-{env}-platform-bus`; S3 `nichols-boxalarm-platform-assets`, `boxalarm-incident-assets`, `boxalarm-exports-staging`.
- Endpoints `/api/v1/{service}/...`, JSON camelCase, RFC 7807 errors with `traceId`; health `GET /api/v1/{service}/health/liveness|readiness` (auth none). notification-service uses verbatim `/notifications...` paths (exception).
- Events lowercase dotted `<domain>.<entity>.<past-tense-verb>`, domain = owning service short name (e.g. `alerting.dispatch.received`, `training.expiry.due`, `inventory.expiry.due`); PascalCase names appear nowhere.
- DynamoDB: `pk/sk/gsiNpk/gsiNsk`, `ENTITY#value`, `{deptId}` in every table PK (`DEPT#{deptId}#...`).
- Repos (retired; now monorepo dirs): boxalarm-ui, boxalarm-backend, boxalarm-infrastructure, boxalarm-docs.

## Cross-Cutting Non-Negotiables
- **Alerting isolation (N1.5):** alerting execution roles hold NO permission on platform/incident tables; fan-out reads only denormalized copies in the alerting table (`MEMBER_ELIGIBILITY_SNAPSHOT`, `PRE_PLAN_COPY`, `HYDRANT_COPY`, `ALERT_RULES_COPY`, `CAD_INGRESS_COPY`). Bridge LOB<-alerting is one-way out. Named identity-path exceptions fail open (authorizer revocation read, Pre Token Generation).
- **Exactly-once key:** `{dispatchId}#{toneSequence}#{memberId}#{channel}` — DynamoDB conditional put (`attribute_not_exists(idempotencyKey)`), receipt `sk=RECEIPT#{memberId}#{channel}#{toneSequence}`. `channelTier` is bookkeeping ONLY, never routing/dedup. FIFO `MessageGroupId=dispatchId`; `MessageDeduplicationId=hash(dispatchId,toneSequence,memberId,channel)` (transport only). Never `BatchWriteItem` for conditional writes. `toneSequence` is a literal in each scheduler payload (2 at T+180s, 3 at T+360s), never computed at fire time.
- **Escalation:** push+SMS parallel at T+0 (one publish per member/channel/tone); voice sole escalation, default N=75s; voice re-arms per tone; tone audience never filtered by `ackStatus`.
- **Event envelope** (every event): `eventId, eventTime, eventType, source, correlationId, schemaVersion, payload`. Outbox pattern for writes that raise events; consumers dedup on `eventId` (48h).
- **Auth:** Cognito sole IdP; authorizer validates signature/audience(`client_id`)/issuer/exp via `aws-jwt-verify` + revocation marker (`iat` <= marker refused, ~30 s). **No MFA, no step-up, no session timeout** (`MfaConfiguration: OFF`, 1h access, 3650-day refresh); export/destructive actions gated by Cedar CHIEF/ADMIN alone, alarmed every invocation. Verified Permissions fail-secure (503, never default allow) except alerting fan-out pipeline. Self sign-up off. Vendor webhooks authenticate by signature/HMAC/SPF-DKIM, not Cognito.
- **Observability:** structured JSON logs w/ `correlationId`+`service`, no PII; W3C traceparent; X-Ray on every Lambda; alerting alarms (fan-out p99 5s, per-channel failure, canary, DLQ depth, `ToneFiredZeroReceipts`) page a human (P0), separate from LOB.
- **Deployment:** no maintenance window; alerting Lambdas via versioned alias + CodeDeploy canary/linear, N1.6 canary + alarms gate/rollback.
- **Data:** audit/receipt/incident entities no TTL (retention via export job, default 7y); PII fields classified (§3.5); no PHI (fire-only, no EMS/ePCR).
- **N1.7 not literally satisfied; N1.9 retained tone-out paging is the compensating control (not optional).**
- DLQ `maxReceiveCount` 3 alerting / 5 others; alerting DLQ alarms page immediately.

## Open Questions
OQ-1 CAD feed the county sends (adapters built: SES email + signed webhook). OQ-2 regional dispatch authority approval (longest pole). OQ-3 SMS/voice vendors (recommendation only: Twilio SMS, AWS End User Messaging Voice; unsigned). OQ-4 Apple Critical Alerts entitlement (filing directed, unconfirmed; code default `critical`, runbook sets `time-sensitive`; not device-verified). OQ-8 canary cadence (2 min proposed). OQ-9 API Gateway deviation ratification (now incl. webhook REST API + stage throttles). OQ-10–14 station hardware, Chief360 migration, CT LOSAP rules, CT state reporting, mutual aid. OQ-15–17 accepted deferrals (no OpenSearch; low-cardinality GSIs; NERIS incident id minted once at alert time). OQ-18 who carries pager at 03:00. OQ-19 CT records retention. OQ-20 mapping provider [ASSUMED]. OQ-21 operator + monthly cost ceiling (estimate ~$120–175/mo; Valkey floor ~$40–50 flagged). OQ-22 members without capable smartphone. OQ-23 NERIS Integration Partner account; NERIS loop unverified live. OQ-24 who revokes sessions/how fast. OQ-25 who may halt tone ladder. [ASSUMED]: CAD vendor/protocol, SMS/voice vendor, mapping provider, CT reporting, Chief360 export. Frontend: react-native-app-auth ratified; native a11y CI, device-farm vendor, op-sqlite vs WatermelonDB open. Approved-not-designed: assist-service (Bedrock, denied to alerting role), live service, presence plane.

## Compiled Provenance
Source: /Users/benjaminrussell/Desktop/Firehouse/Boxalarm-monorepo/.worktrees/member-roles/docs/architecture.md (2840 lines, sha256 0e0c04a3…)
Compiled: 2026-10-02 by sdlc plugin v2.16.0
