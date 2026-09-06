# inspections-service

## Purpose & Boundaries
Occupancy records, pre-incident plans, inspection/violation tracking, hydrant records, and map-based retrieval. Owns the pre-plan/hydrant data `alerting-service` denormalizes into `PRE_PLAN_COPY` for in-alert retrieval (F1.8/F6.2).

## Interfaces
Base path `/api/v1/inspections/...`.

| Method | Path | Auth |
|---|---|---|
| GET / POST | `/occupancies` | Cognito / Cognito(admin) |
| GET / PUT | `/occupancies/{id}/pre-plan` | Cognito / Cognito(admin) |
| GET / POST | `/` (inspection schedule/history, record + violations) | Cognito |
| GET / PUT | `/hydrants` / `/hydrants/{hydrantId}` | Cognito / Cognito(admin) |
| POST | `/field-capture` (offline-sync-tolerant, with photos) | Cognito |
| GET | `/map` | Cognito |

## Data Ownership
On the shared `platform-service` table:
- `OCCUPANCY` - `pk=DEPT#{deptId}#OCCUPANCY#{occupancyId}`, `normalizedAddress` for F1.8/GSI3 address lookup, GSI3 geo bucketing (`GEO#{geohash5}`) plus a second application-level `ADDR#{normalizedAddress}` lookup key on the same GSI.
- `PRE_PLAN` - `sk=PREPLAN#{prePlanId}`, collocated with its OCCUPANCY so an active alert's retrieval is a single Query once the occupancy is resolved by address.
- `INSPECTION_RECORD` - `sk=INSPECTION#{inspectionId}`, GSI2 due-date bucketing.
- `HYDRANT` - `pk=DEPT#{deptId}#HYDRANT#{hydrantId}`, GSI2 flow-test-due and GSI3 geo bucketing.

## Events Produced
- `inspections.preplan.updated` - consumed by `alerting-service` to maintain `PRE_PLAN_COPY`.
- `inspections.hydrant.updated` - consumed by `alerting-service` to maintain `PRE_PLAN_COPY`'s resolved nearest-hydrant refs (resolved at copy-write time, never at fan-out).

## Events Consumed
None on the write path.

## Dependencies
- Internal: `alerting-service` (one-way event consumer of pre-plan/hydrant updates, never a synchronous reader of this table at fan-out time - access pattern #37 is explicitly off the alerting hot path).
- External: none named.

## Gotchas & Constraints
- Hydrant references must be resolved into `PRE_PLAN_COPY` at copy-write time, never looked up during fan-out - a hot-path cross-service read here is exactly the coupling N1.5 forbids.
- Field capture is offline-sync-tolerant (N3.4) - conflict handling treats inspections as append-only submissions, so last-write-wins conflicts are structurally rare.

## Source Sections
- Backend section 1.1 Bounded contexts (service #8), lines 118-142
- Backend section 1.4 Pre-incident plans on an active alert, line 262
- API endpoints, inspections-service, lines 384-397
- Data Model section 3.1 PRE_PLAN_COPY (alerting-owned copy), lines 677-691
- Data Model section 3.3 OCCUPANCY, PRE_PLAN, INSPECTION_RECORD, HYDRANT, lines 1176-1238
- Data Model section 4 Access patterns 37-39, lines 1330-1333
- Testing section 2 F6 matrix, lines 2150-2159
