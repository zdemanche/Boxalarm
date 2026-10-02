# Reporting Service

## Purpose & Boundaries
No primary data. Owns every named compliance/grant report by charter (F8.1-F8.7): chief dashboard, LOSAP year-end, ISO, grants, response-time analytics, membership trends, CSV/PDF export. v1 reads purpose-built GSIs on the platform table; the "Reporting Projections" handler maintains DynamoDB rollup items (pre-aggregated counters) - NOT CQRS.

## Interfaces
`/api/v1/reporting` (all Cognito(admin)): GET `/dashboard`, `/losap/year-end` (sole owner, N-3; aggregates per-member `/personnel/members/{id}/losap`), `/iso`, `/grants`, `/response-times`, `/membership-trends`, `/export` (accept-and-queue for large ranges); health pair. Unlisted but built: cutover-decision and NERIS-compliance reports.

## Data Ownership
Rollup items on platform table (shape not specified). Valkey key `platform-service:dashboard:{deptId}` TTL 5-15 min. NERIS compliance view uses incident GSI1 (`FilterExpression status IN (SUBMITTED,REJECTED)`).

## Events Produced
absent — the source document does not address this

## Events Consumed
`personnel.attendance.recorded` (-> `reporting-projection-queue`); `alerting.tone.escalated`, `alerting.mutual_aid.triggered` (annotate dashboard); `neris.submission.failed` (dashboard projection).

## Dependencies
internal: platform-service table GSIs, personnel-service, incident-service, alerting-service (events), training-service. external: S3 (`boxalarm-exports-staging`, 7-day expiry), Valkey.

## Gotchas & Constraints
- Cached aggregates tolerate minutes of staleness; never cache NERIS "did it go out" status.
- F8.2 LOSAP has a 90% coverage target (municipal/legal). Delivery-rate comparison for N1.9 cutover uses alerting `/delivery-baseline`.
- OpenSearch deferred; fast-follow trigger = second dept live or narrative full-text need.

## Source Sections
§1.1 122-150; §1.4 reporting read model 314; §2 reporting API 456-468; Data Model §1 610-622, §6 1523-1533; Events item 5 1632; Testing F8 2391-2401.
