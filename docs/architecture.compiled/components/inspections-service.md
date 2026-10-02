# Inspections Service

## Purpose & Boundaries
Occupancy records (F6.1), pre-incident plans (F6.2), inspections/violations (F6.3), hydrants (F6.4), mobile offline field capture (F6.5), map retrieval (F6.6). Publishes denormalized copies for alerting. CT fire-marshal permits, fee invoicing, code-enforcement workflows are DEFERRED.

## Interfaces
`/api/v1/inspections`: GET/POST `/occupancies` (POST admin); GET/PUT `/occupancies/{id}/pre-plan`; GET/POST `` (inspections); PUT `/{id}/violations/{code}` (admin; addressed by `code`; re-inspection = new INSPECTION_RECORD); GET `/hydrants`; PUT `/hydrants/{hydrantId}` (admin); POST `/occupancies/{id}/archive`, `/hydrants/{hydrantId}/archive` (admin; take off list partitions and tombstone alerting copy, `docs/runbooks/alert-context-replay.md`); POST `/field-capture`; GET `/map`; health pair.

## Data Ownership
Platform table: `OCCUPANCY` (`pk=DEPT#{d}#OCCUPANCY#{id}`, METADATA; PII address/normalizedAddress/contacts; gsi3 `DEPT#{d}#OCCUPANCY#GEO#{geohash5}`/`{geohash8}#{id}` and second key `DEPT#{d}#OCCUPANCY#ADDR#{normalizedAddress}`), `PRE_PLAN` (`PREPLAN#{prePlanId}`, same partition), `INSPECTION_RECORD` (`INSPECTION#{id}`; violations list `{code, description, status}`; gsi2 `DEPT#{d}#DUE#INSPECTION_RECORD#{YYYY-MM}`), `HYDRANT` (`pk=DEPT#{d}#HYDRANT#{id}`; status IN_SERVICE|OUT_OF_SERVICE; gsi2 `DUE#HYDRANT`, gsi3 `HYDRANT#GEO#{geohash5}`). S3 bucket `nichols-boxalarm-platform-assets`.

## Events Produced
`inspections.preplan.updated`, `inspections.hydrant.updated` (feed alerting copies; hydrants resolved at copy-write time).

## Events Consumed
absent — the source document does not address this

## Dependencies
internal: alerting-service (copy consumers). external: S3 presigned URLs, DynamoDB, mapping provider [ASSUMED, OQ-20].

## Gotchas & Constraints
- Alerting reads only copies; hydrants never looked up at fan-out (AP 37).
- Geo uses 5-char geohash prefix buckets; exact-address lookup via ADDR key.
- Field capture offline-queued with idempotency key.
- Copies rebuildable via replay function; archive tombstones copy.

## Source Sections
§1.1 122–150; §1.4 pre-plan 292; §2 inspections API 470–488; Data Model OCCUPANCY..HYDRANT 1316–1377, PRE_PLAN_COPY 809–824; AP 37–40 1494–1498; Testing F6 2365–2374.
