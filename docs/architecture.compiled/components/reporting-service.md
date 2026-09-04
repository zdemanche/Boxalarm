# reporting-service

## Purpose & Boundaries
Chief dashboard, LOSAP/ISO/grant reports, response-time analytics, CSV/PDF export. Wave 3. Has **no primary data of its own** — queries purpose-built GSIs on the shared `platform-service` table in v1. The OSI (OpenSearch Ingestion) → OpenSearch read model the house standard would normally supply is deferred on cost-floor grounds; DynamoDB Streams are already enabled on all three tables so the pipeline can be added later without touching any write path.

## Interfaces
Base path `/api/v1/reporting/...`. All endpoints `Cognito(admin)`.

| Method | Path | Description |
|---|---|---|
| GET | `/dashboard` | Chief dashboard: staffing, response perf, OOS, expiring certs, NERIS compliance (F8.1) |
| GET | `/losap/year-end` | LOSAP year-end report (F8.2) |
| GET | `/iso` | ISO reporting support (F8.3) |
| GET | `/grants` | AFG/SAFER-style grant-support report (F8.4) |
| GET | `/response-times` | Turnout/travel/total analytics (F8.5) |
| GET | `/membership-trends` | Membership/attendance trends (F8.6) |
| GET | `/export` | CSV/PDF export, accept-and-queue for large ranges (F8.7) |

## Data Ownership
None owned. Reads via purpose-built GSIs on the `platform-service` table (v1). "Reporting Projections" (the internal handler referenced in the Events section) maintains **DynamoDB rollup items** on the `platform-service` table (pre-aggregated counters for the chief dashboard) — this is explicitly **not CQRS**; any reference elsewhere in the source document to "CQRS read models for the Chief Dashboard" is withdrawn.

**Fast-follow trigger for OpenSearch/CQRS** (governs this service's future architecture, not current): adopt DynamoDB Streams → OSI → AOSS NextGen when either (a) a second department goes live and cross-department search is required, or (b) incident volume or full-text narrative search needs exceed what a GSI + FilterExpression over a few-thousand-item partition can serve interactively.

## Events Produced
None.

## Events Consumed
- `personnel.attendance.recorded` — consumed by the "Reporting Projections" internal handler to maintain dashboard rollup counters.

## Dependencies
**Internal:** reads GSIs on `platform-service` table (owned by `personnel-service`, `apparatus-service`, `training-service`, `inspections-service`, `inventory-service`); reads NERIS compliance status from `incident-service`'s GSI1 (`FilterExpression status IN (SUBMITTED,REJECTED)`) for the chief dashboard.
**External:** none.

## Gotchas & Constraints
- **No OpenSearch/CQRS in v1 — do not design as if a search index exists.** Every read pattern here (dashboard aggregation, ISO/grant/LOSAP rollups, response-time analytics) must be expressible as a GSI query + application-side aggregation over a small, known dataset (dozens of members, low hundreds of incidents/year).
- **No full-text narrative search** in v1 — F7.4 narrative capture has no keyword-search access pattern; acceptable at current volume, a real limitation if incident volume grows before the CQRS trigger is reached.
- Chief-dashboard aggregations are cacheable (Valkey, 5–15 min TTL) — tolerant of a few minutes of staleness; nothing else on this service's surface should be cached without the same tolerance check.
- LOSAP year-end report is app-side aggregation across per-member GSI1 queries (small roster) — not a batch job or pre-computed table beyond the dashboard rollup counters.
- CSV/PDF export for this service's own scope (F8.7) is accept-and-queue for large ranges; full-department data export (distinct — F9.5) belongs to `platform-service`, not here.
- GSI3's low-cardinality list-style partitions this service reads from are a documented, accepted tradeoff at one-department scale — do not assume high write throughput per partition.

## Source Sections
- Backend §1.1 Bounded contexts / service table (reporting-service row + notes) — lines 116–142
- Backend §1.4 Reporting read model — line 245
- API endpoints: reporting-service — lines 349–360
- Data Model §1 Summary recommendation (no OpenSearch/CQRS in v1) — lines 465–477
- Data Model §5 Database technology rationale — lines 1236–1246
- Data Model §6 Caching (chief dashboard aggregations) — lines 1248–1259
- Data Model §7 Cost/performance (no OpenSearch cost lever) — lines 1260–1268
- Data Model §10 Risks (no full-text search) — lines 1290–1299
- Events §Reconciliations item 5 (Reporting Projections is not CQRS) — line 1329
- Events §3, §5 (personnel.attendance.recorded consumer) — lines 1398–1420, 1503–1522
- Testing §2 F8 test matrix — lines 1982–1993
