# Runbook: alert-context replay (pre-plan and hydrant copies)

**Function:** `boxalarm-<env>-inspections-alert-context-replay` (inspections-service, invoke-only; no route, no schedule).

**What it does.** The dispatch detail shows a pre-plan and the nearest hydrants from copies in the alerting table (`PRE_PLAN_COPY`, `HYDRANT_COPY`). Alerting-owned consumers build those copies from `inspections.preplan.updated` and `inspections.hydrant.updated`, and **only when one of those events arrives**. The replay re-emits one event per active pre-plan and per active hydrant from its current state, so every copy is (re)built.

## When to run it

1. **After the first deploy of the alert-context consumers** (`PrePlanCopies`), in every environment. Data created before then has no copy, or has a copy without the address and geo index keys. Until the replay runs, every dispatch shows "No pre-plan" and no hydrants.
2. **After any change to the alerting address normalizer** (`backend/src/services/alerting-service/prePlan/addressKey.ts`). Stored copies keep the key computed by the old rules until their occupancy's next event. A copy under a stale key silently never matches.
3. After restoring or migrating the platform table.

It is safe at any time. Nothing on the paging path reads these copies.

## Run it

With credentials for the stack's account:

```sh
# 1. What would be emitted (writes nothing):
aws lambda invoke --function-name boxalarm-<env>-inspections-alert-context-replay \
  --cli-binary-format raw-in-base64-out --cli-read-timeout 0 \
  --payload '{"deptId":"<deptId>","dryRun":true}' /dev/stdout

# 2. Emit:
aws lambda invoke --function-name boxalarm-<env>-inspections-alert-context-replay \
  --cli-binary-format raw-in-base64-out --cli-read-timeout 0 \
  --payload '{"deptId":"<deptId>"}' /dev/stdout
```

The result counts what it did:

```json
{ "deptId": "…", "dryRun": false,
  "prePlans": { "emitted": 41, "skippedConcurrentEdit": 0, "skippedArchived": 0, "skippedNoPrePlan": 12 },
  "hydrants": { "emitted": 310, "skippedConcurrentEdit": 0, "skippedArchived": 0, "skippedNoUpdatedAt": 0 } }
```

`--cli-read-timeout 0` matters. A run can take up to 15 minutes, and the CLI's default 60-second read timeout would otherwise make it retry the invoke. That retry is throttled, because reserved concurrency is 1, and the throttle error is confusing while the first run continues.

Run it once per department. The timeout is 15 minutes. If a very large department times out, rerun it: it is idempotent (see below).

## Guarantees

- **Idempotent.** Each event carries the item's full current state, and the consumers upsert. A second run rewrites the same copies.
- **Race-free.** Each outbox row is written in a transaction with a `ConditionCheck` that the source row's `updatedAt` is still the value the replay read. If an inspector edits the item in between, that item is skipped (`skippedConcurrentEdit`). The edit already emitted its own newer event.
- **Archived items are not replayed.** Archiving an occupancy or hydrant (`POST /api/v1/inspections/occupancies/{id}/archive`, `…/hydrants/{hydrantId}/archive`, CHIEF/ADMIN) takes it off the department list partitions the replay walks. Its alerting copy keeps the tombstone written by the archive event, and the consumers never overwrite a tombstone. A record archived while a run is in progress is caught too: every replay write is conditioned on the record (and, for a pre-plan, its occupancy) not being archived, and is counted as `skippedArchived`.
- **Scope.** LOB plane only. The function can read the platform table. Its only write is `PutItem`, limited by `dynamodb:LeadingKeys` to the `DEPT#*#OUTBOX` partitions, and the audit-row deny is attached. It holds no Update/Delete permission and nothing on the alerting table. The events reach the alerting plane the normal way (outbox drain, platform bus, `PrePlanCopies` queues).

## Check it worked

- Metrics `Boxalarm/alerting-pre-plan`: `PrePlanCopyUpdated` and `HydrantCopyUpdated` should rise by about the emitted counts within a minute. `…MissingFields` / `HydrantCopyMissingLocation` flag records that are stored but cannot be found from a dispatch (no address, or no coordinates). Fix those records in inspections, not here.
- The copy DLQs (`boxalarm-<env>-alerting-preplan-copy-dlq`, `…-hydrant-copy-dlq`) should stay empty. They page through `alerting-page` if they do not.
- Open a dispatch at a pre-planned address. The Pre-plan panel should read "Pre-plan for <address>".

## Home locality (how a pre-plan address match is verified)

Occupancy addresses carry no town, so the dispatch detail needs each department's **home locality** to tell "123 Main St" in Trumbull from "123 Main St, Bridgeport" on a mutual-aid call. The home locality is the set of towns, villages and ZIPs the department's own addresses are written with.

A pre-plan is shown as a plain match ("Pre-plan for …") only when both addresses parsed unambiguously **and** the locality is verified:

- the dispatch names a home town, village or ZIP, either in its address or through the dispatcher's **locality choice**; and
- the pre-plan's own town/ZIP is home (a town-less pre-plan inherits the home locality).

A dispatch naming a town, ZIP or state outside it never matches. A dispatch that names **no** locality is never verified, because "123 Main St" typed for a mutual-aid call looks exactly like a home call.

**The locality choice.** Manual dispatch entry (web and mobile) requires a "Town / village" choice: one of the department's home towns or villages, or "Other town" with the town typed in. It is served by `GET /api/v1/alerting/home-locality` and stored on the dispatch as a separate `locality` field (`{ town, choice: HOME | OTHER }`); the address is never rewritten. It only decides whether a pre-plan can be shown unflagged. Fan-out never reads it, and it never delays a page. The API still accepts older callers that omit it; their dispatches simply never get a verified pre-plan. A malformed `locality` is a 400, like any other invalid field. Anything in between is shown as **"VERIFY ADDRESS"** (`matchType: ADDRESS_UNVERIFIED`).

Where it comes from, first match wins:

1. **The alerting-table item** `pk = DEPT#<deptId>#CONFIG`, `sk = HOME_LOCALITY`. Set this per department; it takes effect on the next dispatch view, with no deploy:

   ```sh
   aws dynamodb put-item --table-name boxalarm-<env>-alerting-table --item '{
     "pk": {"S": "DEPT#<deptId>#CONFIG"}, "sk": {"S": "HOME_LOCALITY"},
     "towns": {"L": [{"S": "Trumbull"}, {"S": "Nichols"}, {"S": "Long Hill"}, {"S": "Trumbull Center"}]},
     "zips":  {"L": [{"S": "06611"}]},
     "state": {"S": "CT"} }'
   ```

2. **The stack default** `ALERTING_HOME_LOCALITY` on the dispatch-detail and home-locality Lambdas. The JSON carries the stack's `deptId`, and the backend applies it to that department only, so a second department never inherits it. It comes from the Pulumi config `boxalarm-infra:alertingHomeLocality` (JSON, same shape). Without that config it falls back to the built-in default for the stack's `deptId` (`infrastructure/components/alerting/home-locality.ts`; `nichols-fd` → Trumbull, Nichols, Long Hill, Trumbull Center, 06611, CT).

3. **Neither.** No match can be verified, and every address match is shown "VERIFY ADDRESS". This is safe but noisy. `pulumi up` warns about it.

**Out-of-area occupancies.** A pre-plan whose address carries no town is treated as in the home area. So an occupancy outside it must be entered with its town, for example an automatic-aid target pre-planned by this department: "12 Oak St, Monroe", not "12 Oak St". Otherwise a home dispatch to "12 Oak St" would verify against it. The web occupancy form says so. There is no server-side check, because inspections (LOB plane) cannot read the alerting-side home set across the IAM boundary, and a second copy of it would drift. To audit, list occupancy addresses with no town and confirm each is in the home area.

**Home ZIPs must be home-only.** List a ZIP only if it covers nothing outside the home area. A ZIP shared with a neighbouring town would let that town's addresses agree on ZIP alone.

If CAD writes a village the set does not list, add it. Until then such calls show "VERIFY ADDRESS" when the ZIP agrees, and no pre-plan otherwise.
