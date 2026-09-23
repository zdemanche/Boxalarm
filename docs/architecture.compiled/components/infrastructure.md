# infrastructure

## Purpose & Boundaries
All Pulumi IaC for every AWS resource across every environment (dev/qa/staging/prod) - the sole owner of AWS deploys. Lives exclusively in the `boxalarm-infrastructure` repo; `boxalarm-backend` and `boxalarm-ui` are build-only and carry no IaC. Wires the 10 backend services to API Gateway, DynamoDB, EventBridge, SNS/SQS, Step Functions/EventBridge Scheduler, Cognito, Verified Permissions, ElastiCache, and S3.

## Interfaces
Not an API surface - deploys via GitHub OIDC to a central org role. Root `Pulumi.yaml` with per-environment stack config; state backend unset (Pulumi Cloud) - `pulumi stack export|import` moves it to org S3 later, not yet done.

## Data Ownership
No application data. Owns: 3 DynamoDB tables (`alerting-service`, `incident-service`, `platform-service` - on-demand, PITR on, Streams on all three), the alerting-plane messaging component `messaging-alerting.ts` (dedicated SNS FIFO topic, per-channel SQS FIFO + DLQ, reserved Lambda concurrency, defined separately from `messaging.ts` for every other domain), the LOB `boxalarm-{env}-platform-bus` EventBridge bus and its per-consumer SQS + DLQ, two S3 buckets (`nichols-boxalarm-platform-assets`, `boxalarm-incident-assets`) plus a short-lived `boxalarm-exports-staging` bucket, ElastiCache Serverless Valkey (VPC-only), Cognito user pool + Verified Permissions policy store per environment.

## Events Produced
None (infrastructure, not a runtime service).

## Events Consumed
None.

## Dependencies
- Internal: every one of the 10 backend services and both frontend build targets depend on this repo's deployed resources; this repo depends on none of them (build-only elsewhere, deploy-only here).
- External: AWS (all resources), GitHub OIDC (deploy auth), Pulumi Cloud (state backend, until migrated to org S3).

## Gotchas & Constraints
- Alerting-plane infra gets its own SNS topic, SQS queues, DLQs, Lambda functions, and reserved concurrency, structurally separate (`messaging-alerting.ts`) from every other domain's shared `messaging.ts` - no consumer outside the alerting domain ever subscribes to the alerting topic, and this must be enforced as an IAM boundary, not a naming convention: `alerting-service` execution roles hold **no IAM permission** to read/write `platform-service` or `incident-service` tables.
- Lambdas are VPC-less by default (avoids ENI cold-start on the alert path); the one exception is ElastiCache Valkey, which is VPC-only - services that use it attach to a VPC, but **no alerting-plane Lambda does**.
- DLQ `RedrivePolicy`: `maxReceiveCount: 3` on alerting queues, `3-5` elsewhere (tighter on alerting so a poison message escalates to a human before burning the 5s p99 fan-out budget on retries).
- Customer-managed KMS key for `alerting-service` and `incident-service` tables; AWS-managed keys for `platform-service` on cost grounds.
- CloudTrail enabled including DynamoDB data events on the alerting table; audit entries and delivery receipts archived to S3 with Object Lock in compliance mode.
- All resources pinned to a U.S. region - a NERIS vendor obligation (N6.1), not a preference; a multi-region or global-edge design would violate it.
- No self-hosted broker (no Kafka/RabbitMQ) - AWS-native pay-per-use only, consistent with the no-24/7-staffed-support constraint.
- Resource naming is `boxalarm-{env}-*` everywhere; any `moonaan-prod-*` name appearing in the source document is template boilerplate to be read as `boxalarm-{env}-*`.
- PITR gives RPO <= 5 minutes for all three tables; RTO target <= 4 hours (LOB) and <= 1 hour (alerting, flagged optimistic - no multi-region standby exists) - a release-gate restore drill must measure and record the actual RTO.
- Region loss and SNS-topic/table-level failure are accepted residual risks with no infra-level mitigation in v1 - compensated procedurally by the N1.9 parallel tone-out run, not by infrastructure redundancy.

## Source Sections
- Backend section 0 Governing decision (API Gateway house-standard reconciliation), lines 106-110
- Backend section 3 Tech stack, lines 413-429
- Eventing section 1 Design rule (alerting is its own isolated messaging plane), lines 1460-1466
- Cross-Cutting - Repository Topology, lines 2445-2458
- Cross-Cutting - Data Protection Retention & DR (encryption, CloudTrail, network posture, RPO/RTO), lines 2494-2507
- Data Model section 1 Summary recommendation (three-table layout), lines 488-501
