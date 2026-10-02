# Infrastructure

## Purpose & Boundaries
All Pulumi (`infrastructure/`; dev/qa/staging/prod, U.S. region pinned `us-east-1`): HTTP API + routes (`infrastructure/components/api/http-api.ts`), the two authorizer Lambdas, CAD webhook REST API, Cognito, Verified Permissions store, DynamoDB tables, messaging (`messaging-alerting.ts` separate from `messaging.ts`), outbox publisher/rule delivery, S3, alarms, CodeDeploy alias rollout. Deploys via GitHub OIDC -> central org role. Backend/UI carry no IaC. State backend unset (Pulumi Cloud).

## Interfaces
Authorizers: main (fail-closed) and alerting (serves only `ALERTING_PLANE_ROUTES`, reserved concurrency 20, `REVOCATION_CHECK_FAIL_OPEN=true`). Fail-open set (17): manual dispatch, dispatch list/detail, roster, responses, tone-ladder advance/halt, mutual-aid trigger/acknowledge, riding board (read+assignments), push-token register/remove, device state, home-locality, self-test (trigger+result). Six officer alerting reads (receipts, diagnostics x2, audit, canary status, delivery baseline) fail CLOSED. `requireAll` seal covers only the 17 alerting routes. Tests: `infrastructure/test/api/fail-open-contract.test.ts` (`FAIL_OPEN_ROUTE_KEYS` == `ALERTING_PLANE_ROUTES`, never an officer read), `infrastructure/test/api/ui-route-contract.test.ts`.

## Data Ownership
Tables: alerting (CMK KMS), incident (CMK KMS), platform (AWS-managed key); Streams on, PITR on, on-demand. CloudTrail data events on alerting table; audit entries/receipts archived to S3 Object Lock compliance mode. Buckets: `nichols-boxalarm-platform-assets`, `boxalarm-incident-assets` (SSE-KMS), `boxalarm-exports-staging` (7-day expiry); Block Public Access, SSE-S3, versioning off, AbortIncompleteMultipartUpload 7d, Intelligent-Tiering IA at 60d, S3 PRESIGNED URLs (not CloudFront) scoped to `{deptId}/{entityType}/{entityId}/` with 10-minute expiry, extension allowlist, PUT signed over Content-Type, size not capped (gap). Valkey VPC-only; no alerting Lambda in a VPC.

## Events Produced
absent — the source document does not address this (infra provisions queues): alerting FIFO queues push/sms/voice/receipts (4) + DLQs; LOB queues training/apparatus/inventory/neris(2)/scheduling/personnel(2)/alert-rules-copy -> 11 SQS queues each with DLQ; scheduler DLQ and Lambda on-failure queue.

## Events Consumed
absent — the source document does not address this

## Dependencies
internal: all services. external: AWS (Lambda, API GW, DynamoDB, SNS/SQS FIFO, EventBridge/Scheduler, Cognito, AVP, KMS, S3, CloudWatch, X-Ray, CodeDeploy, SES, Secrets Manager, SSM, ElastiCache Valkey).

## Gotchas & Constraints
- Queue policies allow `SendMessage` with `aws:SourceArn` = delivering RULE ARN, not bus ARN.
- Outbox publisher: malformed row (missing `source`/`eventTime`/`schemaVersion`) dropped + `MalformedOutboxRow` metric + alarm; per-producer allow-list pending.
- Alerting plane: no maintenance window; every Lambda via versioned alias, CodeDeploy 10%/2min style shift; N1.6 canary against NEW version gates the shift; N8.2 alarms are rollback triggers; new required GSI backfilled before reaching 100%.
- Visibility timeout >= 2x consumer timeout; DLQ maxReceiveCount 3 (alerting)/5 (LOB); `ApproximateNumberOfMessagesVisible > 0` alarm; alerting DLQ pages immediately.
- CAD webhook REST API: usage-plan keys, per-key throttle 5 rps/burst 5; WAF cannot attach to HTTP API; CloudFront ruled out (N6.1, residency test enforces). Alerting authorizer throttle alarms to chief; per-route throttles never below 50 rps/100 burst (100/200 on call-time roster routes).
- Alarms: fan-out p99 vs 5s, per-channel failure, canary, duplicate-delivery counter (=0), `ToneFiredZeroReceipts` P0, `RevocationCheckFailOpen`, snapshot staleness 15 min, export invocation, off-hours privileged activity, `MemberEmailChanged`.
- DR: RPO <=5 min (PITR); RTO <=4h LOB, alerting target <=1h (optimistic; restore drill measures); region loss accepted.
- Region residency test; no moonaan-prod names. Cost: on-demand; Valkey floor flagged.
- Runbooks: `docs/runbooks/first-deploy.md`, `cad-ingress.md`, `alerting-escalation-onfailure.md`, `alert-context-replay.md`, `eligibility-snapshot-repair.md`.

## Source Sections
Overview 7–105; Backend §0 110–118; §3 stack 522–538; §4.1 auth/authorizer 544–554; §4.3–4.5 562–585; Events §1,5,6 1651–1657, 1891–1926; Cost 1544–1567; S3 1569–1580; Cross-cutting 2670–2735.
