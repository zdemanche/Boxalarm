# boxalarm-infrastructure — session handoff

All AWS infrastructure for **Boxalarm**, a fire department operations platform replacing Chief360. Tenant zero: Nichols FD, Trumbull CT.

**This repo is the only thing that touches AWS.** `boxalarm-ui` and `boxalarm-backend` are build-only — if a change provisions a resource, it belongs here.
Pulumi (TypeScript), deployed via GitHub OIDC → central org role. Architecture and backlog live in [`boxalarm-docs`](https://github.com/zdemanche/boxalarm-docs).

## Where things stand (2026-09-03)

**Nothing is scaffolded yet.** The repo holds a README and bootstrap issue [#1](https://github.com/zdemanche/boxalarm-infrastructure/issues/1). Architecture v1.0 and a 90-story backlog are done in `boxalarm-docs`; the user has asked for a **decision gate before the build phase begins**, so do not start provisioning until they say go.

Work is tracked as issues in `boxalarm-docs`, not here.

## Hard constraints

- **U.S. region pinned.** NERIS requires servers inside U.S. geographic boundaries — a vendor obligation, not a preference. No global edge, no cross-region replication.
- **Usage-based cost only.** An unpaid volunteer municipal fire department is paying for this. Anything that idles expensively is the wrong answer — that constraint already drove out OpenSearch, Kafka, and provisioned capacity. Do not reintroduce them.
- **No maintenance window may take alerting down. Ever.**

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

The bootstrap issue predates the rebrand and says `fd-{env}-platform-bus` — use `boxalarm-{env}-platform-bus`.

## Decisions that cost four review rounds — do not relitigate

- **SNS FIFO for alerting, not EventBridge.** FIFO ordering plus `MessageDeduplicationId` is load-bearing for the exactly-once delivery guarantee, and EventBridge has no FIFO mode. LOB traffic stays on EventBridge.
- **Alerting isolation is an IAM boundary, not a naming convention.** `alerting-service` must hold no permission to read the incident or platform tables. Enforce it in the policies you write here — this is where the guarantee actually lives.
- **Alerting Lambdas stay out of the VPC.** ENI cold start on the alert path is not acceptable.
- **N1.7 is documented as NOT literally satisfied.** Retained parallel radio tone-out (N1.9) is the compensating control and is therefore not optional.
- `{deptId}` in every partition key — a second department must be additive, not a rewrite. Single-tenant build, multi-tenant seam.

## Environment separation

Per-environment NERIS base URL, OAuth credentials, and a **distinct `User-Agent`**. Dev traffic must never reach the NERIS production host (N6.4). Stacks: dev, qa, staging, prod.

## How to work here

- **Trace cross-domain seams end to end as a chain, not edit-by-edit.** Every defect in this project so far lived *between* domains, never inside one.
- Use `sdlc:manage-pulumi-infrastructure` and `sdlc:manage-pulumi-project` — don't hand-write Pulumi.
- Tracker is GitHub Issues, not Jira. `/sdlc:generate-code` targets Jira's REST API, so its output has to be converted to `gh issue` calls.
- Prefer Read/Grep/Glob/Edit/Write over `cat`/`sed`/`grep`.
