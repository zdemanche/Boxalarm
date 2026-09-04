# boxalarm-infrastructure

All AWS infrastructure for **[Boxalarm](https://github.com/zdemanche/boxalarm-docs)** — a fire department operations platform. Tenant zero: Nichols Fire Department, Trumbull CT.

**This repo is the only thing that touches AWS.** [`boxalarm-ui`](https://github.com/zdemanche/boxalarm-ui) and [`boxalarm-backend`](https://github.com/zdemanche/boxalarm-backend) are build-only. Pulumi (TypeScript), deployed via GitHub OIDC → central org role.

## Hard constraints

- **U.S. region pinned.** NERIS requires servers inside U.S. geographic boundaries — a vendor obligation, not a preference. No global edge, no cross-region replication.
- **Usage-based cost only.** An unpaid volunteer municipal fire department is paying for this. Anything that idles expensively is the wrong answer; that constraint drove out OpenSearch, Kafka, and provisioned capacity.
- **No maintenance window may take alerting down.** Ever.

## What gets provisioned

| Area | Resources |
|---|---|
| Identity | Cognito user pool, Verified Permissions policy store |
| Data | 3 DynamoDB tables — `alerting`, `incident`, `platform`. On-demand, PITR on, Streams on from day one |
| Alerting transport | SNS **FIFO** topic + per-channel SQS **FIFO** queues, each with a paired DLQ |
| LOB transport | EventBridge `boxalarm-{env}-platform-bus` + rules → consumer SQS queues + DLQs |
| Scheduling | EventBridge Scheduler for one-time escalation timers |
| Compute | Lambda per service. **Alerting Lambdas are not VPC-attached** — no ENI cold start on the alert path |
| Encryption | Customer-managed KMS keys for the alerting and incident tables; AWS-managed for platform. Valkey encrypted at rest and in transit |
| Audit | CloudTrail incl. DynamoDB **data events** on the alerting table; S3 Object Lock (compliance mode) for audit entries and delivery receipts |

**Why SNS FIFO and not EventBridge for alerting:** FIFO ordering plus `MessageDeduplicationId` is load-bearing for the exactly-once delivery guarantee, and EventBridge has no FIFO mode.

## Environment separation

Per-environment NERIS base URL, OAuth credentials, and a distinct `User-Agent`. Dev traffic must never reach the NERIS production host.

## Getting started

Not yet scaffolded — see [#1](https://github.com/zdemanche/boxalarm-infrastructure/issues/1).
