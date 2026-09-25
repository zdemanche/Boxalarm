# infrastructure

## Purpose & Boundaries

All Pulumi IaC for every environment (dev/qa/staging/prod, not every stage necessarily used by this single-department deployment). Sole owner of every AWS resource and all Pulumi state — the `boxalarm-infrastructure` repo. Wires the 10 backend services to API Gateway, DynamoDB, EventBridge, SNS/SQS, Cognito, Verified Permissions, S3. Deploys via GitHub OIDC → central org role. Contains no application/business logic of its own.

## Interfaces

None (no API surface) — this component provisions the infrastructure other components run on and call.

## Data Ownership

None directly, but provisions and configures:

- **3 DynamoDB tables** — `alerting-service` (customer-managed KMS), `incident-service` (customer-managed KMS), `platform-service` (AWS-managed KMS, cost grounds). All on-demand, PITR on, Streams on.
- **2 S3 buckets** — `nichols-boxalarm-platform-assets`, `boxalarm-incident-assets` — plus a third short-lived `boxalarm-exports-staging` (7-day lifecycle, temporary by design). Block Public Access on, SSE-S3 (SSE-KMS for incident bucket), versioning off, `AbortIncompleteMultipartUpload` at 7 days, Intelligent-Tiering with IA transition at 60 days.
- **Messaging:** SNS FIFO alerting topic + per-channel SQS FIFO queues/DLQs; EventBridge bus `boxalarm-{env}-platform-bus` + rule-routed SQS queues/DLQs (11 total SQS queues across both planes); EventBridge Scheduler for one-time timers.
- **Cognito** user pool (single pool per environment, `MfaConfiguration: OFF`).
- **Verified Permissions** policy store (one per environment, Cedar policies).
- **ElastiCache Serverless (Valkey)** — VPC-only; the alert path's Lambdas are explicitly excluded from this VPC.
- **API Gateway HTTP API** (not REST API) + Lambda authorizer.

## Events Produced / Consumed

None directly — provisions the transport (SNS/SQS/EventBridge) that every other component's events flow through.

## Dependencies

**Internal:** every backend service depends on this component for its runtime infrastructure. No backend/frontend repo contains any IaC of its own.

**External:** AWS (all regions pinned `us-east-1`), GitHub OIDC (deploy auth), Pulumi Cloud (state backend, unset explicitly — `pulumi stack export|import` moves it to org S3 later per project handoff notes, not stated in this architecture document itself).

## Gotchas & Constraints

- **`alerting-service`'s execution roles hold literally no IAM permission on `platform-service`/`incident-service` tables** — this is the enforcement mechanism for the whole N1.5/N1.7 isolation invariant; a future code change cannot quietly reintroduce the coupling because the permission simply does not exist to be exploited.
- **No alerting-plane Lambda attaches to a VPC** — Valkey is VPC-only and is the one exception; the alert path deliberately avoids ENI cold-start latency by staying VPC-less, reaching AWS services over TLS-protected, IAM-authenticated public endpoints. Gateway endpoints for DynamoDB/S3 are provisioned in the Valkey VPC for the services that do attach.
- **`alerting-service` deploys have no maintenance window, ever** — every Lambda deploys via a versioned alias with CodeDeploy canary/linear traffic shift; the N1.6 canary is the deployment gate (not a separate synthetic check); existing CloudWatch alarms double as automatic rollback triggers.
- **DLQ `maxReceiveCount`: 3 on alerting-plane queues (tighter — escalate to a human faster, don't burn the 5s p99 budget on retries), 3-5 on LOB-plane queues.**
- **DR targets:** PITR on all three tables gives RPO ≤ 5 minutes. RTO ≤ 4 hours for the LOB plane; a **target** (not yet proven) of ≤ 1 hour for the alerting plane, flagged as optimistic — a release-gate restore drill must measure the actual RTO and replace this target with evidence.
- **CloudTrail enabled including DynamoDB data events on the alerting table** — audit entries and delivery receipts archived to S3 with Object Lock in compliance mode; the IAM write path for audit entries is kept separate from the services whose mutations they record.
- **Repo topology is fixed and non-negotiable per requirements:** 4 repos (`boxalarm-ui`, `boxalarm-backend`, `boxalarm-infrastructure`, `boxalarm-docs`), never a monorepo, never per-service repos — UI and backend are build-only, this repo is the single owner of Pulumi state and the only thing that touches AWS. **Note:** per the project's own working handoff (CLAUDE.md), the repos have since been consolidated into one monorepo (`Boxalarm-monorepo`) with `backend/`, `ui/`, `infrastructure/` directories — this is a post-architecture-document operational change, not a revision to this document's repo-topology section.
- **No dollar figure existed for the "hard budget constraint" until a back-of-envelope estimate was added** (~$120-175/month total, not a quote) — the two largest, least-certain lines are the Valkey per-cache floor cost (~$40-50/mo, AWS-side, resolvable without a vendor decision) and SMS/voice vendor costs (~$60-95/mo combined, blocked on OQ-3).

## Source Sections

- Backend §0 Governing decision, house-standard reconciliation (API Gateway) (`:110-114`)
- Backend §3 Tech stack table (`:448-464`)
- Backend §4.5 Deployment strategy (`:499-509`)
- Data Model §7 Cost and performance considerations, §7.1 Monthly cost estimate (`:1445-1477`)
- Data Model §8 S3 conventions (`:1479-1488`)
- Cross-Cutting: Data Protection & DR (encryption, network posture, RPO/RTO) (`:2617-2629`)
- Cross-Cutting: Repository Topology (`:2568-2581`)
- Eventing Architecture §1 Design rule — alerting's own isolated messaging infra (`:1559-1565`)
