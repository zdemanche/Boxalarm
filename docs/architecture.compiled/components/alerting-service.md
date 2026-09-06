# alerting-service

## Purpose & Boundaries
The isolated life-safety alerting plane: dispatch ingress, per-member channel fan-out/escalation, department-level tone ladder (tones 1-3), mutual-aid prompt, delivery receipts, self-test, canary, and the alert audit log. N1/N1.5 require this plane to degrade independently of every other module in the system — enforced at the IAM layer, not by convention. Owns its own DynamoDB table, own SNS FIFO topic, own SQS FIFO queues + DLQs, own reserved Lambda concurrency. No component here performs a synchronous read or write against `platform-service` or `incident-service` at any point, including fan-out time.

## Interfaces
Base path `/api/v1/alerting/...`. Auth: `Cognito` = end-user JWT; `Cognito(admin)` = JWT + Verified Permissions chief/admin/officer check; `Vendor` = webhook signature/shared secret (not Cognito).

| Method | Path | Auth |
|---|---|---|
| POST | `/ingress/{adapter}` | Vendor |
| POST | `/dispatches` (manual entry, N1.8 degraded mode) | Cognito(admin) |
| GET | `/dispatches/{dispatchId}` (incl. `toneLadder{status,currentToneSequence,nextToneAt,predicateGaps}`, amendment) | Cognito |
| GET | `/dispatches/{dispatchId}/roster` | Cognito |
| POST | `/dispatches/{dispatchId}/responses` | Cognito |
| GET | `/dispatches/{dispatchId}/receipts` | Cognito(admin) |
| POST | `/self-test` | Cognito |
| GET | `/self-test/{testId}` | Cognito |
| POST | `/receipts/push` \| `/receipts/sms` \| `/receipts/voice` | Vendor |
| GET | `/audit` | Cognito(admin) |
| GET | `/canary/status` | Cognito(admin) |
| POST | `/dispatches/{dispatchId}/tone-ladder/advance` (amendment) | Cognito(admin) |
| POST | `/dispatches/{dispatchId}/tone-ladder/halt` (amendment) | Cognito(admin) |
| POST | `/dispatches/{dispatchId}/mutual-aid/trigger` (amendment) | Cognito(admin) |
| POST | `/dispatches/{dispatchId}/mutual-aid/acknowledge` (amendment) | Cognito(admin) |

`DispatchIngressPort` — pluggable adapter interface (webhook, polling, store-and-forward, manual-entry), all normalizing into a canonical `DispatchReceived`/`dispatch.alert.received` record. No adapter chosen (OQ-1, blocking).

## Data Ownership
Own DynamoDB table (Streams on, unused in v1; PITR on; on-demand). Customer-managed KMS key (life-safety evidence).

- `DISPATCH_ALERT` — `pk=DEPT#{deptId}#DISPATCH#{dispatchId}`, `sk=METADATA`. Amendment fields: `toneLadderStatus` (`ACTIVE`|`HALTED_MANUAL`|`COMPLETED`), `currentToneSequence`, `nextToneAt`. `gsi2pk/sk` for dept-wide date-range audit.
- `DELIVERY_RECEIPT` — one immutable item per member per channel **per tone**. `sk=RECEIPT#{memberId}#{channel}#{toneSequence}`. `idempotencyKey={dispatchId}#{toneSequence}#{memberId}#{channel}`, `attribute_not_exists` guard. No TTL. `gsi1pk=MEMBER#{memberId}`.
- `DISPATCH_ROSTER_ENTRY` — mutable "current answer" rollup, `sk=ROSTER#{memberId}`, carries `lastAnsweredTone` (amendment), last-writer-wins on `ackAt`.
- `DISPATCH_RESPONSE_RECORD` (amendment, append-only) — every answer ever given, `sk=RESPONSE#{memberId}#{answeredAt}`, `toneSequence` field. Written unconditionally in the same `TransactWriteItems` as the roster-entry conditional update.
- `MEMBER_ELIGIBILITY_SNAPSHOT` — `pk=DEPT#{deptId}#ELIGIBILITY`, `sk=MEMBER#{memberId}`. Denormalized from `personnel-service` events; includes `roles` (amendment, targets officers for mutual-aid prompt). Staleness alarm at 15 min, propagation target <30s p99.
- `PRE_PLAN_COPY` — `pk=DEPT#{deptId}#PREPLAN`, `sk=OCCUPANCY#{occupancyId}`. Denormalized from `inspections-service`; hydrant refs resolved at copy-write time.
- `ALERT_RULES_COPY` (amendment) — `pk=DEPT#{deptId}#ALERT_RULES`, `sk=METADATA`. `toneLadder{tone2AtSeconds,tone3AtSeconds,mutualAidAfterTone}` (defaults 180/360/3), `retoneRespondingMembers` (default true), `voiceEscalatesPerTone` (default true), `defaultRule{minResponders,requiredQuals}`, `callTypeOverrides`. Denormalized from `platform-service` via `platform.config.alert_rules.updated`.
- `ESCALATION_EVENT` — `sk=ESCALATION#{memberId}#{toneSequence}#{escalatedAt}`.
- `TONE_EVENT` (amendment) — two item shapes: singleton fire-guard `sk=TONE#{toneSequence}` (conditional-put guard, no timestamp), and append-only audit row `sk=TONE#{toneSequence}#{evaluatedAt}`. `outcome`: `FIRED`|`FIRED_MANUAL_OVERRIDE`|`SKIPPED_PREDICATE_MET`|`SKIPPED_ALREADY_FIRED`|`SKIPPED_MANUALLY_HALTED`|`SKIPPED_NO_CONFIG`.
- `MUTUAL_AID_EVENT` (amendment) — `sk=MUTUALAID#SINGLETON` (fixed, one per dispatch ever, conditional put). `reason`: `TONE_3_PREDICATE_UNMET`|`MANUAL`. `adapterUsed=OFFICER_MANUAL_PROMPT` (only shipped adapter).
- Officer mutual-aid push item — `sk=MAPROMPT#{memberId}#PUSH` (its own namespace, never `RECEIPT#...`). `idempotencyKey={dispatchId}#MUTUALAID#{memberId}#push`.
- `SELF_TEST_RUN` — `pk=DEPT#{deptId}#MEMBER#{memberId}`, `sk=SELFTEST#{runAt}`. TTL 365 days.
- `CANARY_RUN` — `pk=DEPT#{deptId}#CANARY#{YYYY-MM-DD}`, `sk=RUN#{ranAt}`. TTL 90 days.

## Events Produced
- `dispatch.alert.received` (from ingress adapter)
- `alerting.dispatch.normalized` — tone-1 default; tones 2/3 re-publish the same type carrying `toneSequence` verbatim from the schedule payload, never incremented. Payload includes `channel`, `channelTier`, `toneSequence`, dispatch content, `eligibilityBasis`.
- `alerting.delivery.receipt` (amended, `toneSequence` added)
- `alerting.escalation.triggered` — per-member channel escalation (push/SMS→voice), same shape as `dispatch.normalized` with `channelTier` advanced and `reason:"no_ack_at_tier"`.
- `alerting.tone.escalated` (new, amendment) — audit/observability only, not delivery-critical. `{dispatchId, toneSequence, firedAt, outcome, predicateSnapshot, eligibleMemberCount}`.
- `alerting.mutual_aid.triggered` (new, amendment) — `{dispatchId, triggeredAt, reason, predicateSnapshot, adapterUsed, officersNotified}`.
- `alerting.canary.result` — published directly to CloudWatch, not through the queue under test.
- `alerting.response.confirmed` — republished one-way outward to the LOB bus.
- One-way bridge allow-list to `boxalarm-{env}-platform-bus`: `dispatch.alert.received`, `alerting.response.confirmed`, `alerting.tone.escalated`, `alerting.mutual_aid.triggered` — outward only, never inward except the config-copy event below.

## Events Consumed
- `personnel.member.updated`, `personnel.eligibility.changed`, `personnel.availability.changed` → maintain `MEMBER_ELIGIBILITY_SNAPSHOT`.
- `inspections.preplan.updated`, `inspections.hydrant.updated` → maintain `PRE_PLAN_COPY`.
- `platform.config.alert_rules.updated` (amendment) → maintain `ALERT_RULES_COPY`, via `alert-rules-copy-queue` + DLQ off `boxalarm-{env}-platform-bus` — this is the one direction a LOB-plane event legitimately crosses into alerting (same pattern as the other two denormalized copies), not a violation of the one-way bridge (which restricts the opposite direction only).

## Dependencies
- **Internal**: `personnel-service` (eligibility snapshot source, event-only), `inspections-service` (pre-plan/hydrant copy source, event-only), `platform-service` (alert-rules config source, event-only; also the sole external reader via the export role), `incident-service` (shares the NERIS `dispatchId`/`incidentId`, ID-reference only, no table access).
- **External**: APNs/FCM (push, unavoidable single vendor per platform but independent of SMS/voice), SMS vendor (unselected, OQ-3), voice vendor (unselected, OQ-3, must differ from SMS vendor), CAD/dispatch system (unselected, OQ-1), Mutual Aid Port (officer-manual-prompt adapter only; CAD-relay variant not designed, gated on OQ-1/OQ-2).

## Gotchas & Constraints
- Exactly-once key is 4 segments: `{dispatchId}#{toneSequence}#{memberId}#{channel}`. 3-segment forms are explicitly wrong.
- `toneSequence` must be a literal payload field fixed at EventBridge Scheduler schedule-creation time, never computed at fire time (Scheduler is at-least-once).
- `channelTier` is bookkeeping only — never routing, never dedup. Routing/dedup key on `channel`.
- `BatchWriteItem` cannot carry a `ConditionExpression` — never use it for any conditional write here; use `TransactWriteItems`/`PutItem`.
- Audience for tones 2/3 is the **full current eligible-member set**, re-resolved fresh each tone from `MEMBER_ELIGIBILITY_SNAPSHOT` — never filtered by `ackStatus`. A member who answered `NOT_RESPONDING` or `RESPONDING` is, by default, re-toned anyway (`retoneRespondingMembers` default true).
- `PUT /platform/config` must reject an `ALERT_RULES.requiredQuals` entry naming a qualification code no currently-eligible member holds — validator is a named obligation, not designed in the amendment; an unvalidated impossible predicate fires tone 3/mutual aid on every dispatch of that call type.
- If `ALERT_RULES_COPY` is absent (greenfield, no config written), the ladder does not auto-fire blind — `outcome=SKIPPED_NO_CONFIG` plus a CloudWatch alarm. Manual advance remains available.
- Manual `advance` is a conditional `UpdateItem` keyed on the officer's observed `expectedCurrentToneSequence` (`ConditionExpression: currentToneSequence = :expected`) — a retried/double-tapped request fails the condition rather than minting a further tone.
- A member's `toneSequence` in a response body is **never trusted raw** — server clamps it to `DISPATCH_ALERT.currentToneSequence` before writing `DISPATCH_RESPONSE_RECORD`.
- Custom metric `ToneFiredZeroReceipts` (amendment, M2) — Tone Evaluator emits it on every `FIRED`/`FIRED_MANUAL_OVERRIDE` outcome if no corresponding `DELIVERY_RECEIPT` items for that `toneSequence` exist shortly after for the expected audience. P0 alarm, page-immediately tier.
- No cache anywhere on this hot path — eligibility/pre-plan/rules reads come straight from the denormalized DynamoDB copies.
- Self-test and canary reuse the identical production pipeline flagged `isTest:true` — a canary testing a parallel simplified path is rejected as dishonest.
- Voice re-arms on every tone by default (`voiceEscalatesPerTone`) — up to 3 voice attempts per never-acking member per dispatch; no partial-ladder design exists.
- N1.7 is NOT literally satisfied at the SNS topic/table/region/fan-out-Lambda layer — these are accepted SPOFs. N1.9 parallel tone-out paging is the compensating control and is not optional.
- DLQ `maxReceiveCount: 3` on alerting queues (tighter than the LOB-plane default of 5) so a poison message escalates to a human before burning the 5s p99 budget on retries.

## Source Sections
- Backend §1.1 Bounded contexts (service #1), lines 118-142
- Backend §1.2 CAD/dispatch ingress, lines 144-153
- Backend §1.3 Alerting pipeline (N1 detail), lines 155-232
- Backend §1.3a Department-level tone ladder and mutual aid, lines 233-243
- Backend §1.4 Cross-service integration, lines 245-264 (messaging/event-naming reconciliation notes)
- API endpoints, alerting-service, lines 272-292
- Data Model §3.1 alerting-service table, lines 566-786
- Data Model §3.4 Retention/TTL, lines 1268-1279
- Data Model §4 Access patterns 1-11, lines 1285-1303
- Eventing §1-2, 4.1, 5, 7, 7a, lines 1460-1518, 1560-1662, 1676-1698, 1713-1728
- Cross-Cutting → SPOF table, lines 2477-2492
- Cross-Cutting → Data Protection (encryption, export exception), lines 2494-2507
- Testing §1.2/§2 F1/N1 matrix, §3.2 items 1-7a, lines 2040-2100, 2233-2247
