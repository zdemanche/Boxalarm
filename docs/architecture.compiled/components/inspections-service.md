# Inspections Service

## Purpose & Boundaries
Occupancy records (F6.1), pre-incident plans (F6.2), inspection scheduling/violations (F6.3), hydrants (F6.4), mobile field capture with photos, offline-tolerant (F6.5), map-based retrieval (F6.6), archive. Source of `inspections.*` events that feed alerting's denormalized pre-plan/hydrant copies. Wave 4; shares `platform` table. CT permits/fee invoicing/code-enforcement workflows deferred; read-only fire-marshal sharing proceeds.

## Interfaces
`/api/v1/inspections`: GET/POST `/occupancies` (POST admin); GET/PUT `/occupancies/{id}/pre-plan` (PUT admin); GET/POST `/inspections`; PUT `/inspections/{id}/violations/{code}` (admin; addressed by `code`; re-inspection recording same code = new entry on a new INSPECTION_RECORD); GET `/hydrants`; PUT `/hydrants/{hydrantId}` (admin; flow test/OOS); POST `/occupancies/{id}/archive` and `/hydrants/{hydrantId}/archive` (admin; take off list partitions and tombstone alerting copy); POST `/field-capture`; GET `/map`; health pair.

## Data Ownership
OCCUPANCY `pk=DEPT#{deptId}#OCCUPANCY#{occupancyId}` `sk=METADATA` (PII address, normalizedAddress, contacts; gsi3 `DEPT#{deptId}#OCCUPANCY#GEO#{geohash5}`/`{geohash8}#{occupancyId}` plus second key `DEPT#{deptId}#OCCUPANCY#ADDR#{normalizedAddress}`); PRE_PLAN `sk=PREPLAN#{prePlanId}` (siteDiagramS3Key, attachmentS3Keys, utilityShutoffs, hazards); INSPECTION_RECORD `sk=INSPECTION#{inspectionId}` (violations list `{code, description, status}`; gsi2 `DEPT#{deptId}#DUE#INSPECTION_RECORD#{YYYY-MM}`); HYDRANT `pk=DEPT#{deptId}#HYDRANT#{hydrantId}` (status IN_SERVICE|OUT_OF_SERVICE; gsi2 `DUE#HYDRANT`, gsi3 `DEPT#{deptId}#HYDRANT#GEO#{geohash5}`/`{geohash8}#{hydrantId}`). S3 `{deptId}/preplan/{id}/...`. Access patterns 37b-40.

## Events Produced
`inspections.preplan.updated`, `inspections.hydrant.updated` (feed alerting copies; replay via `docs/runbooks/alert-context-replay.md`); archive emits tombstone to alerting copy.

## Events Consumed
absent — the source document does not address this.

## Dependencies
internal: alerting-service (copies), mobile-app, web-console. external: S3 (presigned URLs), mapping provider (OQ-20, unselected).

## Gotchas & Constraints
- Alerting reads PRE_PLAN_COPY/HYDRANT_COPY; hydrant refs resolved at copy-write time; fan-out never reads them.
- Cross-module read during an active alert must not touch alert-path failure domain (N1.5).
- Violation PUT is last-writer-wins.
- GSI3 geohash cells are the resharding path for low-cardinality partitions.

## Source Sections
Backend §1.1 (122-150) and roadmap amendment (150); §2 inspections-service (470-488); Data Model OCCUPANCY..HYDRANT (1316-1377); PRE_PLAN_COPY (809-824); access patterns 37-40 (1494-1498)
