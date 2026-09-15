# boxalarm-backend — session handoff

Service code for **Boxalarm**, a fire department operations platform replacing Chief360. Tenant zero: Nichols FD, Trumbull CT.
TypeScript / Node.js LTS, Lambda-per-route under `src/services/<name>/`.

**Build only — no Pulumi in this repo.** All AWS lives in `boxalarm-infrastructure`.
Product context, architecture, and the backlog live in [`boxalarm-docs`](https://github.com/zdemanche/boxalarm-docs) — read `docs/architecture.md` there before implementing anything.

## Where things stand (2026-09-03)

**Nothing is scaffolded yet.** The repo holds a README and bootstrap issue [#1](https://github.com/zdemanche/boxalarm-backend/issues/1). Architecture v1.0 and a 90-story backlog are done in `boxalarm-docs`; the user has asked for a **decision gate before the build phase begins**, so do not start generating services until they say go.

Work is tracked as issues in `boxalarm-docs`, not here — this repo carries only its bootstrap issue.

## Two planes — the load-bearing split

An outage in reporting, training, or inventory must never degrade alert delivery. This is life-safety software; the app replaces radio tone-out as the alerting path of record.

- **Alerting plane (isolated):** `alerting-service` — dispatch ingress, fan-out, escalation, delivery receipts, self-test, canary, audit log. Own DynamoDB table, own SNS FIFO topic, own SQS FIFO queues + DLQs. **Holds no IAM permission to read the other two tables** — the isolation is an IAM boundary, not a convention, so a future code change cannot quietly reintroduce coupling. Reads a denormalized eligibility snapshot; never calls another service synchronously at fan-out.
- **LOB plane:** `platform-service` · `personnel-service` · `apparatus-service` · `incident-service` · `training-service` · `reporting-service` · `inspections-service` · `inventory-service` · `notification-service`. Consume from EventBridge. `notification-service` shares **no** queue, concurrency reservation, or provider account with the alerting plane.

## Alert-path invariants — do not get these wrong

> ⚠️ Read [boxalarm-docs#11](https://github.com/zdemanche/boxalarm-docs/issues/11) before touching the alert path. This exact seam produced a **silent SMS-never-sends defect three review rounds running** — each fix landed on one link of the chain and left another inconsistent.

- **Routing and dedup both key on `channel`** (`push`/`sms`/`voice`). `channelTier` (`primary`/`escalation`) is escalation bookkeeping **only** — never a routing filter, never a dedup input. Getting this wrong means SMS silently never sends: no error, no DLQ, no receipt.
- **One publish per `{member, channel}`.** The parallel push+SMS guarantee comes from two publishes, not two subscription filters on one.
- **Exactly-once key is `{dispatchId}#{toneSequence}#{memberId}#{channel}`** (tone-ladder amendment — without `toneSequence`, tones 2/3 silently no-op). One immutable receipt per channel attempt per tone; escalation creates a new receipt and never mutates an existing one, so per-channel delivery evidence survives.
- **`BatchWriteItem` cannot carry a `ConditionExpression`** — use `TransactWriteItems`.
- **Never test against NERIS production.** Separate dev environment, distinct `User-Agent` per environment.
- `{deptId}` in every partition key — a second department must be additive, not a rewrite.

## Conventions

RFC 7807 errors with `traceId` · W3C `traceparent` propagation · outbox pattern for every write that raises an event · Cognito + Verified Permissions enforced server-side · structured logging + X-Ray · NERIS-native (NFIRS retired 2026-01-31, not supported).

Shared internal packages are named `@boxalarm/*`. The bootstrap issue predates the rebrand and says `@fd/*` — use `@boxalarm/*`.

## How to work here

- **Trace cross-domain seams end to end as a chain, not edit-by-edit.** Every defect in this project so far lived *between* domains, never inside one.
- Route codegen/architecture/review through the `sdlc:*` agents — don't hand-write it.
- Moonaan standards apply, but **not** `sdlc:mfe-architecture` — there is no MFE topology in this project.
- Tracker is GitHub Issues, not Jira. `/sdlc:generate-code` targets Jira's REST API, so its output has to be converted to `gh issue` calls.
- Prefer Read/Grep/Glob/Edit/Write over `cat`/`sed`/`grep`.
