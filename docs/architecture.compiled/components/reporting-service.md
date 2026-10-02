# Reporting Service

## Purpose & Boundaries
Chief dashboard (F8.1), LOSAP year-end (F8.2), ISO (F8.3), grant-support (F8.4), response-time analytics (F8.5), membership trends (F8.6), CSV/PDF export (F8.7). Charter: owns every named compliance/grant report F8.1-F8.7. No primary data; reads purpose-built GSIs on the `platform` table (v1; OpenSearch deferred). "Reporting Projections" handler maintains DynamoDB rollup counters (not CQRS). Wave 3.

## Interfaces
`/api/v1/reporting` (all Cognito admin): GET `/dashboard` (staffing, response perf, OOS, expiring certs, NERIS compliance), `/losap/year-end` (sole owner; `/api/v1/personnel/losap/year-end` removed N-3; aggregates per-member `/personnel/members/{memberId}/losap`), `/iso`, `/grants`, `/response-times`, `/membership-trends`, `/export` (accept-and-queue for large ranges); health pair. Cutover-decision and NERIS-compliance reports registered but untabulated.

## Data Ownership
No tables of its own; rollup items on `platform` table (shape not specified). Valkey `platform-service:dashboard:{deptId}` TTL 5-15min. NERIS compliance view uses incident GSI1 with `FilterExpression status IN (SUBMITTED,REJECTED)`. Access patterns 16 (GSI1 per member, aggregated app-side), 26, 30, 36, 49. Exports staged in `boxalarm-exports-staging` (7-day lifecycle).

## Events Produced
absent — the source document does not address this.

## Events Consumed
`personnel.attendance.recorded` (via `reporting-projection-queue`+DLQ); `neris.submission.failed` (chief dashboard projection); `alerting.tone.escalated`, `alerting.mutual_aid.triggered` (annotate dashboard).

## Dependencies
internal: platform-service table, personnel-service, incident-service, training-service, apparatus-service. external: Valkey, S3.

## Gotchas & Constraints
- Reporting must stay off transactional and alerting paths.
- Cache is a soft dependency; NERIS submission status ("did it go out") is never cached.
- No full-text narrative search in v1; fast-follow trigger for OpenSearch = second department live or narrative search need.
- 90% coverage target on LOSAP year-end logic. N1.9 delivery-rate comparison uses alerting `/delivery-baseline`.

## Source Sections
Backend §1.1 (122-150); §1.4 reporting read model (314); §2 reporting-service (456-468); Events reconciliation 5 (1632); Data Model caching (1523-1533); Testing F8 (2391-2401)
