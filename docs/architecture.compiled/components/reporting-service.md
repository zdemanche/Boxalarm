# reporting-service

## Purpose & Boundaries
Chief dashboard, LOSAP/ISO/grant reports, response-time analytics, and CSV/PDF export. Has no primary data of its own - a read model over the `platform-service` table's purpose-built GSIs (and, for NERIS compliance, `incident-service`'s GSI1). The OpenSearch/OSI read model the house standard would normally supply is deliberately deferred, not rejected, on cost-floor grounds.

## Interfaces
Base path `/api/v1/reporting/...`, all `Cognito(admin)`.

| Method | Path |
|---|---|
| GET | `/dashboard` (F8.1 - staffing, response perf, OOS, expiring certs, NERIS compliance) |
| GET | `/losap/year-end` |
| GET | `/iso` |
| GET | `/grants` |
| GET | `/response-times` |
| GET | `/membership-trends` |
| GET | `/export` (accept-and-queue for large ranges) |

## Data Ownership
None directly - reads GSI1/GSI2/GSI3 on `platform-service` (roster, LOSAP, training, apparatus, occupancy) and GSI1 on `incident-service` (submission status, response times). The "Reporting Projections" consumer maintains DynamoDB rollup items on the `platform-service` table (pre-aggregated counters for the chief dashboard) - explicitly not CQRS/a separate read store.

## Events Produced
None directly; the Reporting Projections handler consumes and writes rollups.

## Events Consumed
- `personnel.attendance.recorded` - maintains dashboard rollup counters.
- `neris.submission.failed` - feeds the Chief Dashboard NERIS-compliance projection.

## Dependencies
- Internal: `platform-service` (primary data source via GSIs), `incident-service` (NERIS compliance view), `personnel-service` (LOSAP/attendance source events).
- External: none named.

## Gotchas & Constraints
- No full-text narrative search in v1 (F7.4 has no search-by-keyword access pattern) - acceptable at low-hundreds/year incident volume; the fast-follow trigger for OpenSearch/CQRS adoption is (a) a second department going live needing cross-department search, or (b) incident/narrative-search volume exceeding what a GSI+FilterExpression over a few-thousand-item partition serves interactively.
- Never cache anything reflecting alert delivery state or NERIS "did it go out" status - those must always read source of truth. Ordinary dashboard aggregations (staffing, OOS, expiring certs) are Valkey-cacheable at 5-15 min TTL.
- CSV/PDF export for large ranges is accept-and-queue, not synchronous.

## Source Sections
- Backend section 1.1 Bounded contexts (service #7), lines 118-142
- Backend section 1.4 Reporting read model, line 264
- API endpoints, reporting-service, lines 372-383
- Data Model section 1, section 5 (OpenSearch deferral rationale), lines 488-501, 1347-1358
- Data Model section 6 Caching, lines 1359-1369
- Eventing section 1 reconciliation item 5 (Reporting Projections is not CQRS), lines 1421-1441
- Testing section 2 F8 matrix, lines 2176-2187
