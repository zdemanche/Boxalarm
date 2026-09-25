# alerting-service

## Purpose & Boundaries

Isolated life-safety alerting plane. Dispatch ingress, exactly-once fan-out to eligible members across push/SMS/voice, per-member channel escalation, department-level tone ladder (re-toning the whole eligible roster up to 2 more times based on aggregate response), mutual-aid prompt, delivery receipts, self-test, continuous production canary, alert audit log. This is service 1 of 10, Wave 1. N1/N1.5/N1.7 govern the whole shape of this service: it must degrade **independently** of every other module in the platform, enforced as an IAM boundary (no alerting execution role can read/write `platform-service` or `incident-service` tables). Own DynamoDB table, own SNS FIFO topic, own SQS FIFO queues + DLQs, own Lambda reserved concurrency — shares nothing with any other service.

## Interfaces

Base path `/api/v1/alerting/...`, JSON camelCase, RFC 7807 errors + `traceId`. Auth: `Cognito` = end-user JWT; `Cognito(admin)` = JWT + Verified Permissions chief/admin/officer check; `Vendor` = webhook signature/shared secret.

| Method | Path | Description | Auth |
|---|---|---|---|
| POST | `/ingress/{adapter}` | CAD/vendor dispatch ingress, adapter-specific payload | Vendor |
| POST | `/dispatches` | Manual dispatch entry (N1.8 degraded-mode fallback) | Cognito(admin) |
| GET | `/dispatches/{dispatchId}` | Dispatch detail; `toneLadder` object (`status`, `currentToneSequence`, `nextToneAt`, `predicateGaps`) | Cognito |
| GET | `/dispatches/{dispatchId}/roster` | Live response roster (F1.7) | Cognito |
| POST | `/dispatches/{dispatchId}/responses` | Member response confirmation + ETA (F1.6) | Cognito |
| GET | `/dispatches/{dispatchId}/receipts` | Per-member sent/delivered/opened receipts (F1.3) | Cognito(admin) |
| POST | `/self-test` | Trigger self-test alert to caller's own devices (F1.10) | Cognito |
| GET | `/self-test/{testId}` | Self-test result | Cognito |
| POST | `/receipts/push` \| `/receipts/sms` \| `/receipts/voice` | Provider delivery/status/call-outcome callbacks | Vendor |
| GET | `/audit` | Alert delivery audit log, filterable (F1.11) | Cognito(admin) |
| GET | `/canary/status` | Current canary health (N1.6) | Cognito(admin) |
| POST | `/dispatches/{dispatchId}/tone-ladder/advance` | Fire next tone now, bypassing timer/predicate (F1.14) | Cognito(admin) |
| POST | `/dispatches/{dispatchId}/tone-ladder/halt` | Halt scheduled tone evals + suppress auto mutual-aid (F1.14) | Cognito(admin) |
| POST | `/dispatches/{dispatchId}/mutual-aid/trigger` | Manually trigger mutual aid pre-tone-3 (F1.13) | Cognito(admin) |
| POST | `/dispatches/{dispatchId}/mutual-aid/acknowledge` | Confirm mutual-aid phone call made; notes | Cognito(admin) |
| GET | `/health/liveness` \| `/health/readiness` | Health (readiness includes N1.6 canary signal) | none |

## Data Ownership

Own DynamoDB table (`alerting-service`), on-demand, PITR on, Streams on (feeds a future OSI pipeline only, not consumed in v1), customer-managed KMS key.

- **DISPATCH_ALERT** — `pk=DEPT#{deptId}#DISPATCH#{dispatchId}`, `sk=METADATA`. Core dispatch record: address/crossStreets (**PII**), narrative, hydrant/pre-plan refs, `idempotencyKey` (CAD dedup), `toneLadderStatus` (`ACTIVE`|`HALTED_MANUAL`|`COMPLETED`), `currentToneSequence`, `nextToneAt`. GSI2: `DEPT#{deptId}` / `DISPATCH#{dispatchedAt}`.
- **DELIVERY_RECEIPT** — `sk=RECEIPT#{memberId}#{channel}#{toneSequence}`. One immutable item per member per channel per tone attempt — never mutated across escalation. `channel` (`PUSH`|`SMS`|`VOICE`) is the routing/dedup key; `channelTier` (`primary`|`escalation`) is bookkeeping only. `idempotencyKey = {dispatchId}#{toneSequence}#{memberId}#{channel}`, `attribute_not_exists` guard. No TTL (life-safety evidence). GSI1: `MEMBER#{memberId}` / `RECEIPT#{sentAt}#{dispatchId}`.
- **DISPATCH_ROSTER_ENTRY** — `sk=ROSTER#{memberId}`. Member-level mutable rollup for F1.7 live view: `ackStatus`, `ackAt`, `eta`, `assignedApparatusId`, denormalized `quals`, `currentChannelTier`, `lastAnsweredTone`. Last-writer-wins on `ackAt`. No TTL.
- **DISPATCH_RESPONSE_RECORD** — `sk=RESPONSE#{memberId}#{answeredAt}`. Append-only immutable answer history (every answer ever given, any tone). No TTL.
- **MEMBER_ELIGIBILITY_SNAPSHOT** — `pk=DEPT#{deptId}#ELIGIBILITY`, `sk=MEMBER#{memberId}`. Denormalized eligibility copy (C-2 isolation invariant), maintained by `personnel.member.updated`/`personnel.eligibility.changed`/`personnel.availability.changed`. Fields: `active`, `quals`, `roles`, `contactChannels` (**PII**), `availabilityState`, `snapshotUpdatedAt`. **Fan-out reads this, never the platform table.** Staleness alarm at 15 min; propagation target <30s p99.
- **PRE_PLAN_COPY** — `pk=DEPT#{deptId}#PREPLAN`, `sk=OCCUPANCY#{occupancyId}`. Denormalized pre-plan copy (F1.8/F6.2), hydrant refs resolved at copy-write time, never at fan-out.
- **ALERT_RULES_COPY** — `pk=DEPT#{deptId}#ALERT_RULES`, `sk=METADATA`. Denormalized copy of tone-ladder config: `toneLadder` (`tone2AtSeconds`/`tone3AtSeconds`/`mutualAidAfterTone`), `retoneRespondingMembers` (default `true`), `voiceEscalatesPerTone` (default `true`), `defaultRule`/`callTypeOverrides` (`minResponders`, `requiredQuals`). Maintained by `platform.config.alert_rules.updated`.
- **ESCALATION_EVENT** — `sk=ESCALATION#{memberId}#{toneSequence}#{escalatedAt}`. Per-member channel escalation log.
- **TONE_EVENT** — two shapes: singleton fire-guard `sk=TONE#{toneSequence}` (conditional-put guard, `attribute_not_exists`), and timestamped audit row `sk=TONE#{toneSequence}#{evaluatedAt}` (append-only). `outcome`: `FIRED`|`FIRED_MANUAL_OVERRIDE`|`SKIPPED_PREDICATE_MET`|`SKIPPED_ALREADY_FIRED`|`SKIPPED_MANUALLY_HALTED`|`SKIPPED_NO_CONFIG`.
- **MUTUAL_AID_EVENT** — `sk=MUTUALAID#SINGLETON` (fixed, one per dispatch ever, conditional put). `adapterUsed=OFFICER_MANUAL_PROMPT`; `officersNotified` from `MEMBER_ELIGIBILITY_SNAPSHOT.roles` containing `OFFICER`|`CHIEF`; `notes` free text (guidance-only PII scrub, not enforced).
- **SELF_TEST_RUN** — `pk=DEPT#{deptId}#MEMBER#{memberId}`, `sk=SELFTEST#{runAt}`. TTL 365 days.
- **CANARY_RUN** — `pk=DEPT#{deptId}#CANARY#{YYYY-MM-DD}`, `sk=RUN#{ranAt}`. Date-bucketed. TTL 90 days.

## Events Produced

- `alerting.dispatch.normalized` — per `{member, channel, toneSequence}` publish (one publish per triple, not per member); `toneSequence` defaults 1, tones 2/3 carry the literal value from the invoking schedule payload, never incremented at publish time.
- `alerting.delivery.receipt` — normalized provider webhook status, `toneSequence` included.
- `alerting.escalation.triggered` — per-member channel escalation (push/SMS → voice), `reason: "no_ack_at_tier"`.
- `alerting.tone.escalated` — dept-level tone fire, audit/observability only, not delivery-critical. Also republished across the one-way bridge to the LOB plane.
- `alerting.mutual_aid.triggered` — mutual-aid trigger fact. Also republished across the one-way bridge.
- `alerting.canary.result` — direct to CloudWatch PutMetricData, bypasses the queue under test.
- `alerting.dispatch.received` — republished across the one-way bridge (allow-listed).
- `alerting.response.confirmed` — republished across the one-way bridge (allow-listed).

Transport for all of the above: SNS FIFO `boxalarm-{env}-alerting-topic.fifo`, `MessageGroupId=dispatchId`, `MessageDeduplicationId=hash(dispatchId, toneSequence, memberId, channel)` → per-channel SQS FIFO queues (`alerting-push-queue.fifo`, `alerting-sms-queue.fifo`, `alerting-voice-queue.fifo`, `alerting-receipts-queue.fifo`), each with its own DLQ, `maxReceiveCount: 3`.

## Events Consumed

- `personnel.member.updated`, `personnel.eligibility.changed`, `personnel.availability.changed` — maintain `MEMBER_ELIGIBILITY_SNAPSHOT`.
- `inspections.preplan.updated`, `inspections.hydrant.updated` — maintain `PRE_PLAN_COPY`.
- `platform.config.alert_rules.updated` — maintain `ALERT_RULES_COPY`. Transport: `boxalarm-{env}-platform-bus` → `alert-rules-copy-queue` + DLQ (`maxReceiveCount: 5`) — this is the one sanctioned inbound direction into the alerting plane (same direction as the other two denormalized-copy events, not against the one-way bridge).

## Dependencies

**Internal:** none synchronous — by design (C-2 isolation invariant), only event-driven denormalized copies from `personnel-service`, `inspections-service`, `platform-service`. `incident-service` correlates via a shared, ID-only `dispatchId`/`incidentId` (no table join).

**External:** APNs / FCM (push, unavoidable single vendor per platform but independent of SMS/voice); SMS vendor (**unselected — OQ-3**); Voice vendor (**unselected, must differ from SMS vendor — OQ-3**); CAD/dispatch vendor via `DispatchIngressPort` (**unselected — OQ-1/OQ-2, blocking**).

## Gotchas & Constraints

- **`channelTier` is NEVER a routing or dedup input.** Push and SMS share tier `primary`; a tier-keyed dedup ID makes their two publishes byte-identical and SNS FIFO silently discards the SMS one — no error, no DLQ, no receipt. This is a named, previously-shipped defect class (#119) — regression test required: one dispatch, one member, assert two distinct provider sends at T+0.
- **`toneSequence` must be a literal fixed at schedule-creation time, never computed from observed state at fire time.** EventBridge Scheduler is at-least-once; deriving "next tone = current+1" at fire time lets a redelivered invocation mint a tone early (duplicate-storm generator on the tone axis).
- **Audience for tones 2/3 is NEVER filtered by `ackStatus`** — re-resolved fresh from `MEMBER_ELIGIBILITY_SNAPSHOT` every tone; only ineligibility (marked off, unqualified, inactive) removes a member. A `NOT_RESPONDING` or `RESPONDING` answer at tone 1 does not exempt a member from tone 2/3 by default.
- **Conditional-put idempotency happens in the channel worker, immediately before the provider send call — not only at fan-out.** A fan-out-only put leaves a redelivery outside FIFO's 5-minute dedup window unguarded against the provider.
- **Never `BatchWriteItem` for any guarded write** — it cannot carry a `ConditionExpression`. Use `TransactWriteItems` or per-item `PutItem`.
- **Officer manual mutual-aid push uses `MAPROMPT#{memberId}#PUSH`, never `RECEIPT#...`** — an already-toned officer already holds a `RECEIPT#` key at that sk shape, and reusing it would silently no-op.
- **No cache on the alerting hot path, ever.** Eligibility/pre-plan/config reads come straight from the denormalized DynamoDB copies in this table.
- **APNs `apns-collapse-id` and the Android notification id must be `{dispatchId}#{toneSequence}`, not `dispatchId` alone** — a dispatchId-only id lets the OS coalesce a tone-2 push into tone-1's existing notification, silently swallowing the re-tone at the device even though the backend correctly sent it (mobile-app concern, but the backend key discipline is what makes it possible to get right).
- **`ALERT_RULES_COPY` absent (greenfield, no config written)** → Tone Evaluator does not fire blind: outcome `SKIPPED_NO_CONFIG`, CloudWatch alarm raised. Manual advance remains available regardless.
- **`PUT /platform/config` (owned by platform-service) must reject a `requiredQuals` entry naming a qualification no currently-eligible member holds** — an unvalidated impossible predicate fires tone 3 + mutual aid on every dispatch of that call type. Validator is a named obligation, not designed in the source document.
- **N1.7 is NOT literally satisfied** — the SNS FIFO topic, the DynamoDB table, the region, and the Fan-out Lambda are each an accepted, documented single point of failure. The retained parallel tone-out paging (N1.9) is the compensating control and is therefore not optional until this changes. Chaos testing must be scoped to the channel layer only, never the topic/table/region layer.
- **`ToneFiredZeroReceipts` custom metric** — emitted by the Tone Evaluator whenever a `FIRED`/`FIRED_MANUAL_OVERRIDE` `TONE_EVENT` produces zero corresponding `DELIVERY_RECEIPT` items for the expected audience within a short window — P0 page-immediately alarm, the direct instrument for a silently-swallowed re-tone.

## Source Sections

- Architecture Overview & diagram (`:7-104`)
- Backend §0-1.3a Service architecture, CAD ingress, alerting pipeline, tone ladder (`:110-246`)
- Backend §1.4 Cross-service integration / messaging transport (`:249-268`)
- Backend §2 alerting-service API endpoints (`:276-299`)
- Backend §3-4 Tech stack, Auth, Health checks, Deployment strategy (`:448-509`)
- Data Model §3.1 `alerting-service` table entities (`:619-844`)
- Data Model §3.4 Retention/TTL (`:1321-1333`)
- Data Model §4 Access patterns 1-11 (`:1357-1418`)
- Events §Alerting domain, producer/consumer table (`:1520-1821`)
- Eventing Architecture §1-3, §7-7a (`:1557-1621`, `:1836-1851`)
- Cross-Cutting: Single Points of Failure table (`:2600-2615`)
- Cross-Cutting: Data Protection (encryption, session policy) (`:2617-2629`)
- Open Questions OQ-1 through OQ-25 alerting-relevant items (`:2650-2719`)
