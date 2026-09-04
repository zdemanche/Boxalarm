# boxalarm-backend

Service code for **[Boxalarm](https://github.com/zdemanche/boxalarm-docs)** — a fire department operations platform. Tenant zero: Nichols Fire Department, Trumbull CT.

**Build only — no infrastructure code lives here.** All Pulumi is in [`boxalarm-infrastructure`](https://github.com/zdemanche/boxalarm-infrastructure).

TypeScript / Node.js LTS. Lambda-per-route (or small route group) under `src/services/<name>/`.

## Two planes

The system splits into a **life-safety alerting plane** and a **line-of-business plane**. This is not stylistic — an outage in reporting, training, or inventory must never degrade alert delivery.

### Alerting plane — isolated

`alerting-service` — dispatch ingress, fan-out, escalation, delivery receipts, self-test, canary, audit log.

- Own DynamoDB table, own SNS FIFO topic, own SQS FIFO queues + DLQs
- **Holds no IAM permission to read the other two tables.** The isolation is an IAM boundary, not a convention, so a future code change cannot quietly reintroduce coupling
- Reads a denormalized eligibility snapshot — never calls another service synchronously at fan-out

### Line-of-business plane

`platform-service` · `personnel-service` · `apparatus-service` · `incident-service` · `training-service` · `reporting-service` · `inspections-service` · `inventory-service` · `notification-service`

Consume from EventBridge. `notification-service` shares **no** queue, concurrency reservation, or provider account with the alerting plane.

## Rules that are easy to get wrong

> ⚠️ **Read [boxalarm-docs#11](https://github.com/zdemanche/boxalarm-docs/issues/11) before touching the alert path.** This seam produced a silent defect three review rounds running.

- **Routing and dedup both key on `channel`** (`push`/`sms`/`voice`). `channelTier` (`primary`/`escalation`) is escalation bookkeeping **only** — never a routing filter, never a dedup input. Getting this wrong means SMS silently never sends: no error, no DLQ, no receipt.
- **One publish per `{member, channel}`** — the parallel push+SMS guarantee comes from two publishes, not two subscription filters on one.
- **Exactly-once key is `{dispatchId}#{memberId}#{channel}`.** One immutable receipt per channel attempt; escalation creates a new receipt and never mutates an existing one, so per-channel delivery evidence survives.
- **`BatchWriteItem` cannot carry a `ConditionExpression`** — use `TransactWriteItems`.
- **Never test against NERIS production.** Separate dev environment, distinct `User-Agent` per environment.

## Conventions

RFC 7807 errors with `traceId` · W3C `traceparent` propagation · outbox pattern for every write that raises an event · Cognito + Verified Permissions, enforced server-side · structured logging + X-Ray.

## Getting started

Not yet scaffolded — see [#1](https://github.com/zdemanche/boxalarm-backend/issues/1).
