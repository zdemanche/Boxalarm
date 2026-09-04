# inspections-service

## Purpose & Boundaries
Occupancy records, pre-incident plans, inspection/violation tracking, hydrants, map retrieval. Wave 4. Data on the shared `platform-service` table. Source of the pre-plan/hydrant data that `alerting-service` denormalizes into `PRE_PLAN_COPY` for retrieval from within a live alert (F1.8) — never read live at fan-out time.

## Interfaces
Base path `/api/v1/inspections/...`.

| Method | Path | Description | Auth |
|---|---|---|---|
| GET | `/occupancies` | Occupancy records (F6.1) | Cognito |
| POST | `/occupancies` | Create occupancy | Cognito(admin) |
| GET | `/occupancies/{id}/pre-plan` | Pre-incident plan incl. attachments/diagrams/shutoffs (F6.2) | Cognito |
| PUT | `/occupancies/{id}/pre-plan` | Update pre-plan | Cognito(admin) |
| GET | `/` | Inspection schedule/history (F6.3) | Cognito |
| POST | `/` | Record inspection + violations | Cognito |
| GET | `/hydrants` | Hydrant records: location/size/flow/status (F6.4) | Cognito |
| PUT | `/hydrants/{hydrantId}` | Update hydrant (flow test, OOS) | Cognito(admin) |
| POST | `/field-capture` | Mobile field capture with photos, offline-sync-tolerant (F6.5) | Cognito |
| GET | `/map` | Map-based retrieval (F6.6) | Cognito |

## Data Ownership
On the shared `platform-service` table.

- **OCCUPANCY (F6.1)** — `pk=DEPT#{deptId}#OCCUPANCY#{occupancyId}`, `sk=METADATA`. `normalizedAddress` supports F1.8/GSI3 address lookup. `gsi3pk/sk` = `DEPT#{deptId}#OCCUPANCY#GEO#{geohash5}` / `{geohash8}#{occupancyId}`; **also** written with a second, application-level logical partition value `gsi3pk=DEPT#{deptId}#OCCUPANCY#ADDR#{normalizedAddress}` on the same GSI for exact-address retrieval an active alert needs.
- **PRE_PLAN (F6.2)** — `pk=DEPT#{deptId}#OCCUPANCY#{occupancyId}` (collocated with its OCCUPANCY so F1.8 retrieval is one `Query` once the occupancy is resolved), `sk=PREPLAN#{prePlanId}`. `siteDiagramS3Key`/`attachmentS3Keys` → `nichols-boxalarm-platform-assets`.
- **INSPECTION_RECORD (F6.3)** — `sk=INSPECTION#{inspectionId}`. `violations[]` = `{code, description, status}`. `gsi2pk/sk` = `DEPT#{deptId}#DUE#INSPECTION_RECORD#{YYYY-MM}` / `{nextDueDate}#{inspectionId}`.
- **HYDRANT (F6.4)** — `pk=DEPT#{deptId}#HYDRANT#{hydrantId}`, `sk=METADATA`. `status` IN_SERVICE|OUT_OF_SERVICE. `gsi2pk/sk` (flow-test due) and `gsi3pk/sk` (geo) both present.

## Events Produced
- `inspections.preplan.updated` — consumed by `alerting-service` to maintain `PRE_PLAN_COPY`, with hydrant references resolved at copy-write time (not at fan-out).
- `inspections.hydrant.updated` — same consumer/purpose as above.

## Events Consumed
None named.

## Dependencies
**Internal:** publishes event-driven denormalized copies to `alerting-service` (never a synchronous call — this service being down must never block or slow alert fan-out, N1.5). Referenced by `incident-service`/`alerting-service` via ID reference for hydrant/pre-plan lookups on active alerts.
**External:** mapping provider — **unselected** (OQ-20), low architectural risk but needed for F1.8 map link and F6.6 map retrieval.

## Gotchas & Constraints
- **`alerting-service` never reads this service live.** `PRE_PLAN_COPY` and hydrant refs are pre-resolved at event-copy-write time; access pattern #37 (hydrant resolution on an alert) is explicitly off the hot path — do not add a synchronous lookup during fan-out.
- **Mobile field capture (F6.5) must be offline-sync-tolerant** (N3.4) — same idempotency/replay discipline as elsewhere in the offline strategy: a client-generated idempotency key prevents double-submission on reconnect.
- Map-based retrieval (F6.6) uses 5-character-geohash prefix bucketing across candidate GSI3 cells — a multi-`Query` fan-out across geo cells, not a single query.
- GSI3's occupancy/hydrant partitions are geo-bucketed (higher cardinality than the flat department-entity-type partitions used elsewhere) — this entity class is not part of the accepted low-cardinality tradeoff that applies to apparatus/defect/checklist-run lists.
- Pre-plan/occupancy attachments live in `nichols-boxalarm-platform-assets`, prefix `{deptId}/{entityType}/{entityId}/{filename}`, client uploads via CloudFront signed URLs (10-min expiration) scoped to that exact prefix.

## Source Sections
- Backend §1.1 Bounded contexts / service table — lines 116–142
- Backend §1.4 Pre-incident plans on an active alert (F6.2) — line 243
- Backend §1.3 Alerting isolation invariant (PRE_PLAN_COPY table) — lines 205–219
- API endpoints: inspections-service — lines 362–374
- Data Model §3.3 OCCUPANCY, PRE_PLAN, INSPECTION_RECORD, HYDRANT — lines 1072–1134
- Data Model §4 Access patterns #37b–39 — lines 1220–1222
- Data Model §8 S3 conventions — lines 1269–1278
- Events §7 New events note (hydrant/preplan not among the newly-defined ones, but denormalization events reference this service's updates) — lines 1337–1345
- Testing §2 F6 test matrix — lines 1956–1966
