# alerting-service

## Purpose & Boundaries
Dispatch ingress, fan-out, escalation, delivery receipts, self-test, continuous canary, and the alert delivery audit log. Wave 1. The one isolated life-safety system in the product — the architecture is organized around holding N1/N1.5 ("no outage anywhere else may impair alerting") true at every layer: own DynamoDB table, own SNS FIFO topic, own SQS FIFO queues + DLQs, own reserved Lambda concurrency, own IAM boundary. No component of this service performs a synchronous read or write against `platform-service` or `incident-service` at any point on the alert hot path or otherwise — enforced by IAM, not convention. The sole exception in the whole system is `POST /platform/export`'s dedicated read-only role (owned by `platform-service`), which may read this table; nothing here can read out.

## Interfaces
Base path `/api/v1/alerting/...`. Auth model: `Cognito` = end-user JWT; `Cognito(admin)` = JWT + Verified Permissions chief/admin/officer check; `Vendor` = signature/shared-secret webhook auth, not Cognito.

| Method | Path | Description | Auth |
|---|---|---|---|
| POST | `/ingress/{adapter}` | CAD/vendor dispatch ingress (adapter-specific payload) | Vendor |
| POST | `/dispatches` | Manual dispatch entry — N1.8 degraded-mode fallback | Cognito(admin) |
| GET | `/dispatches/{dispatchId}` | Dispatch detail incl. normalized alert content (F1.8) | Cognito |
| GET | `/dispatches/{dispatchId}/roster` | Live response roster: responding/ETA/quals/apparatus (F1.7) | Cognito |
| POST | `/dispatches/{dispatchId}/responses` | Member response confirmation + ETA (F1.6) | Cognito |
| GET | `/dispatches/{dispatchId}/receipts` | Per-member sent/delivered/opened receipts (F1.3) | Cognito(admin) |
| POST | `/self-test` | Trigger self-test to caller's own devices (F1.10) | Cognito |
| GET | `/self-test/{testId}` | Self-test result | Cognito |
| POST | `/receipts/push` | Push-provider delivery/open callback | Vendor |
| POST | `/receipts/sms` | SMS delivery-status callback | Vendor |
| POST | `/receipts/voice` | Voice call-outcome callback | Vendor |
| GET | `/audit` | Alert delivery audit log, filterable (F1.11) | Cognito(admin) |
| GET | `/canary/status` | Current canary health (N1.6, feeds N8.3) | Cognito(admin) |

`DispatchIngressPort` — canonical internal interface every CAD/vendor adapter normalizes into, producing a `DispatchReceived` (dotted: `dispatch.alert.received`) record: incident type, address, cross-streets, units requested, narrative, external dispatch ID. Candidate adapters (none confirmed — OQ-1): webhook, polling, store-and-forward (email/SMS-to-alert), manual-entry (doubles as N1.8 degraded mode).

Query/admin endpoints above go through the Cognito authorizer + Verified Permissions; the fan-out/escalation hot path itself has **no per-request authorization decision** (background pipeline).

## Data Ownership
Own DynamoDB table (`alerting-service`), on-demand, PITR on, Streams on (feeds a future OSI pipeline only — not consumed by anything in v1), customer-managed KMS key.

- **DISPATCH_ALERT** — `pk=DEPT#{deptId}#DISPATCH#{dispatchId}`, `sk=METADATA`. `dispatchId` = NERIS-format `deptId+dispatchNumber+epochSeconds`, minted once at alert ingestion and reused unchanged as `incident-service`'s `INCIDENT` key (assumption — verify against real NERIS behavior, OQ-17). `sourceSystem` CAD|MANUAL|SELF_TEST. `idempotencyKey` = dedup key from CAD feed (dedupes CAD retries, pattern-1 conditional put). `hydrantRefs`/`prePlanRefs` are ID references only. `gsi2pk/sk` = `DEPT#{deptId}` / `DISPATCH#{dispatchedAt}`.
- **DELIVERY_RECEIPT** — `sk=RECEIPT#{memberId}#{channel}`. **One immutable item per member per channel attempt** — never mutated across escalation (a per-member item would overwrite each channel's `sentAt`/`deliveredAt`/`failureReason`, destroying F1.3/F1.11 evidence and the N1.9 cutover basis). `channel` is PUSH|SMS|VOICE, immutable. `channelTier` is bookkeeping only — never routing/dedup. `idempotencyKey = {dispatchId}#{memberId}#{channel}`, guarded by `attribute_not_exists`. **No TTL** — retained 7yr default via a separate scheduled export-to-S3-Glacier job (Wave 3), never item expiry. Writes via `TransactWriteItems`/`PutItem`; never `BatchWriteItem` (cannot carry a `ConditionExpression`).
- **DISPATCH_ROSTER_ENTRY** — member-level rollup, `sk=ROSTER#{memberId}`, one row per member (not per channel), serves F1.7. Updated on each receipt/ack: `ackStatus`, `eta`, `assignedApparatusId`, denormalized `quals`, `currentChannelTier`, `escalationLevel`.
- **MEMBER_ELIGIBILITY_SNAPSHOT** — `pk=DEPT#{deptId}#ELIGIBILITY`, `sk=MEMBER#{memberId}`. Denormalized copy owned here, maintained *event-driven* from `personnel.member.updated`/`personnel.eligibility.changed`/`personnel.availability.changed`. **Fan-out reads this, never the platform table.** Staleness alarm at 15 min; propagation target <30s p99.
- **PRE_PLAN_COPY** — `pk=DEPT#{deptId}#PREPLAN`, `sk=OCCUPANCY#{occupancyId}`. Denormalized from `inspections.preplan.updated`/`inspections.hydrant.updated`; hydrant refs resolved **at copy-write time**, never looked up during fan-out.
- **ESCALATION_EVENT** — `sk=ESCALATION#{memberId}#{escalatedAt}`.
- **SELF_TEST_RUN** — `pk=DEPT#{deptId}#MEMBER#{memberId}`, `sk=SELFTEST#{runAt}`. TTL 365 days (operational, not audit evidence).
- **CANARY_RUN** — `pk=DEPT#{deptId}#CANARY#{YYYY-MM-DD}` (date-bucketed for real cardinality), `sk=RUN#{ranAt}`. TTL 90 days.

GSI1 (`MEMBER#{memberId}`) serves member self-view of alert history / F1.11 / N8.3. GSI2 (`DEPT#{deptId}`) serves department-wide audit by date range.

## Events Produced
Envelope per spine (`eventId`, `eventTime`, `eventType`, `source`, `correlationId`=`dispatchId`, `schemaVersion`, `payload`).

- `alerting.dispatch.normalized` — `{dispatchId, memberId, channel, channelTier, incidentType, address, crossStreets, mapLink, narrative, prePlanLink, hydrantLink, eligibilityBasis[]}`. One publish per `{member, channel}` pair (not per member) — required for the channel-keyed `MessageDeduplicationId` to exist at publish time.
- `alerting.escalation.triggered` — same shape, `channelTier` advanced, `reason: "no_ack_at_tier"`.
- `alerting.delivery.receipt` — `{dispatchId, memberId, channel, channelTier, status, providerTimestamp, providerMessageId}`.
- `alerting.canary.result` — `{runId, channelsTested[], endToEndLatencyMs, outcome}`. Published **direct to CloudWatch PutMetricData, not through the queue under test** — a queue outage must not blind the canary.
- Republished outward to the LOB plane (one-way only, narrow allow-list): `dispatch.alert.received`, `alerting.response.confirmed`.

## Events Consumed
- `personnel.member.updated`, `personnel.eligibility.changed`, `personnel.availability.changed` (from `personnel-service`) — maintain `MEMBER_ELIGIBILITY_SNAPSHOT`. `AVAILABILITY_MARKOFF.affectsAlerting` is event-propagated into the snapshot, never read cross-service at fan-out time.
- `inspections.preplan.updated`, `inspections.hydrant.updated` (from `inspections-service`) — maintain `PRE_PLAN_COPY`, with hydrant refs resolved at copy time.

## Dependencies
**Internal (event-driven only, never synchronous):** `personnel-service`, `inspections-service`. **Correlates with** `incident-service` via a shared, ID-reference-only `dispatchId`/`incidentId` (no shared table, no join).
**External:** APNs/FCM (push, unavoidable single vendor per platform but independent of SMS/voice); SMS vendor (unselected, OQ-3); voice vendor (unselected, must differ from SMS vendor per N1.2, OQ-3); CAD/dispatch system (vendor/protocol unconfirmed, OQ-1, OQ-2).

## Gotchas & Constraints
- **Exactly-once key is `{dispatchId}#{memberId}#{channel}` — per-channel, never per-member alone.** `dispatchId#memberId` alone is explicitly wrong and must not be implemented; a regression test (one dispatch, one member, assert two distinct provider sends at T+0) is mandatory.
- **Routing and dedup key on `channel`, never `channelTier`.** Push and SMS share tier `primary`; a tier-keyed `MessageDeduplicationId` makes SNS FIFO silently discard the SMS publish — no error, no DLQ, no receipt.
- **Two-layer idempotency, deliberately.** SNS/SQS FIFO `MessageDeduplicationId = hash(dispatchId, memberId, channel)` is a cost-free first filter (5-min window only); the DynamoDB conditional put on `idempotencyKey`, executed **in the channel worker immediately before the provider send call** (not only at fan-out), is the actual enforced guarantee.
- **Escalation ladder is push+SMS parallel at T+0, voice the sole escalation tier at T+N=75s default (F9.3-configurable).** Not a sequential ladder — any sequential-SMS-after-push description elsewhere in the source is superseded.
- **No cache on this hot path, ever.** Eligibility reads come straight from the DynamoDB denormalized copy; Valkey is explicitly excluded from delivery-confirmation and alert state.
- **BatchWriteItem is forbidden** for any receipt/roster write — it cannot carry a `ConditionExpression`, and every write here depends on one.
- **Self-test (F1.10) and canary (N1.6) reuse the identical production pipeline**, flagged `isTest: true` so they never fan out to real channels but exercise every hop. A canary testing a simplified/parallel path is explicitly rejected as a design.
- **N1.7 is NOT literally satisfied** — SNS FIFO topic, this table, the fan-out Lambda, and the AWS region are each an accepted single point of failure with no alternate path. N1.9 (retained parallel tone-out paging) is the compensating control and is not optional. Chaos tests here are scoped to the channel layer only.
- **DLQ:** `maxReceiveCount: 3` (tighter than the LOB plane's 3–5) — a poison message should escalate to a human faster rather than burn the 5s p99 budget on retries. Alerting DLQ alarms page on-call immediately.
- **Ordering:** FIFO `MessageGroupId = dispatchId` — a member's push/SMS/voice attempts for one dispatch process in publish order, never interleaving with another dispatch's messages in the same group.
- **RTO target ≤ 1 hour is flagged optimistic** — a PITR restore-to-new-table on a cold procedure is not reliably one hour with no multi-region standby; a release-gate restore drill must measure and record the actual figure.
- **Auth on this service's fan-out core has no re-authentication or MFA obligation whatsoever** (system-wide policy — see spine Cross-Cutting) — do not add a step-up prompt anywhere on the alert path; a re-auth prompt appearing here is a documented test failure, not a hardening improvement.

## Source Sections
- Architecture Overview (diagram) — lines 7–100
- Backend §0 Governing decision — lines 106–111
- Backend §1.1 Bounded contexts / service table — lines 116–142
- Backend §1.2 CAD/dispatch ingress — lines 144–153
- Backend §1.3 Alerting pipeline (N1 detail) — lines 155–224
- Backend §1.4 Cross-service integration (roster/pre-plan denormalization) — lines 226–245
- API endpoints: alerting-service — lines 253–269
- Data Model §1 Summary recommendation — lines 465–477
- Data Model §3.1 alerting-service table (all entities) — lines 540–682
- Data Model §3.4 Retention/TTL — lines 1164–1175
- Data Model §4 Access patterns #1–9, #11, #37 — lines 1181–1234
- Data Model §7 Cost/performance (fan-out burst) — lines 1260–1268
- Events §Reconciliations + §1–7 (transport, exactly-once, routing, envelope, notification-service routing) — lines 1310–1345
- Eventing Architecture §1–9 (full alerting event flow, schema, producer/consumer table, error handling, canary) — lines 1346–1554
- Testing §1.1–1.3 (Tier 0 pyramid, N1 properties as tests) — lines 1809–1867
- Testing §2 F1/N1 test matrix — lines 1875–1905
- Testing §3.2 Tier 0 E2E flows — lines 2039–2050
- Cross-Cutting → Single Points of Failure table (N1.7) — lines 2279–2294
- Cross-Cutting → Data Protection (encryption, RTO/RPO, audit immutability) — lines 2296–2308
