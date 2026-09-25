# inspections-service

## Purpose & Boundaries

Occupancy records, pre-incident plans, inspection/violation tracking, hydrants, map-based retrieval. Service 8 of 10, Wave 4. Logical service on the shared `platform-service` physical table.

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
| PUT | `/{id}/violations/{code}` | Update one violation's status (N-9, decided) — a re-inspection recording the same code is a new list entry on a new `INSPECTION_RECORD`, not an update to this one | Cognito(admin) |
| GET | `/hydrants` | Hydrant records: location/size/flow/status (F6.4) | Cognito |
| PUT | `/hydrants/{hydrantId}` | Update hydrant (flow test, OOS) | Cognito(admin) |
| POST | `/field-capture` | Mobile field capture w/ photos, offline-sync-tolerant (F6.5) | Cognito |
| GET | `/map` | Map-based retrieval (F6.6) | Cognito |
| GET | `/health/liveness` \| `/health/readiness` | Health | none |

## Data Ownership

On `platform-service` physical table.

- **OCCUPANCY** — `pk=DEPT#{deptId}#OCCUPANCY#{occupancyId}`, `sk=METADATA`. `address`/`normalizedAddress`/`contacts` **PII**. GSI3: `DEPT#{deptId}#OCCUPANCY#GEO#{geohash5}` and a second application-level lookup key `DEPT#{deptId}#OCCUPANCY#ADDR#{normalizedAddress}` for exact-address retrieval from an active alert (F1.8).
- **PRE_PLAN** — `pk=DEPT#{deptId}#OCCUPANCY#{occupancyId}` (collocated with its OCCUPANCY), `sk=PREPLAN#{prePlanId}`.
- **INSPECTION_RECORD** — `sk=INSPECTION#{inspectionId}`. `violations`: `{code, description, status}`.
- **HYDRANT** — `pk=DEPT#{deptId}#HYDRANT#{hydrantId}`, `sk=METADATA`. GSI2 due-dates + GSI3 geo.

## Events Produced

- `inspections.preplan.updated` — consumed by `alerting-service` to maintain `PRE_PLAN_COPY`.
- `inspections.hydrant.updated` — consumed by `alerting-service` to maintain `PRE_PLAN_COPY`'s resolved hydrant refs.

## Events Consumed

None named directly.

## Dependencies

**Internal:** `alerting-service` (one-way — this service publishes, alerting-service consumes and denormalizes into its own table; never a synchronous read back into `inspections-service`).

**External:** S3 (`nichols-boxalarm-platform-assets`) for site diagrams/attachments/inspection photos.

## Gotchas & Constraints

- **Pre-plan retrieval from within an active alert (F6.2) must never touch the alerting-plane's failure domain.** `alerting-service` keeps its own denormalized `PRE_PLAN_COPY` with hydrant refs resolved at copy-write time, never looked up live during fan-out — this service is entirely off the alert hot path.
- **`OCCUPANCY` is written with two logical GSI3 partition-key patterns** (GEO and ADDR) on the same GSI — a normalized-address string is high-cardinality enough on its own to serve as a partition key without an artificial shard.
- **Violation updates are per-inspection, not a mutable ledger** — `PUT /{id}/violations/{code}` addresses a violation within its own `INSPECTION_RECORD.violations` list; a repeat inspection is a new record.

## Source Sections

- Backend §1.1 Service inventory (`:120-146`)
- Backend §1.4 Pre-incident plans on an active alert pattern (`:266`)
- Backend §2 inspections-service API endpoints (`:400-416`)
- Data Model §3.3 OCCUPANCY, PRE_PLAN, INSPECTION_RECORD, HYDRANT (`:1229-1291`)
- Data Model §3.5 PII classification (OCCUPANCY) (`:1339-1354`)
- Data Model §4 Access patterns 37b-39 (`:1405-1407`)
