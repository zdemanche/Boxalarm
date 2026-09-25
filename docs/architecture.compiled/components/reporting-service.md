# reporting-service

## Purpose & Boundaries

Chief dashboard, LOSAP/ISO/grant reports, response-time analytics, CSV/PDF export. Service 7 of 10, Wave 3. Has no primary data of its own — in v1 it queries purpose-built GSIs on the `platform-service` physical table. The OpenSearch/OSI read model the house standard would normally supply is explicitly deferred on cost-floor grounds, not rejected.

## Interfaces

Base path `/api/v1/reporting/...`. All endpoints `Cognito(admin)`.

| Method | Path | Description |
|---|---|---|
| GET | `/dashboard` | Chief dashboard: staffing, response perf, OOS, expiring certs, NERIS compliance (F8.1) |
| GET | `/losap/year-end` | LOSAP year-end report (F8.2). Sole owner (N-3, decided) — the duplicate `/api/v1/personnel/losap/year-end` was removed; `personnel-service` keeps only the per-member running total this endpoint aggregates |
| GET | `/iso` | ISO reporting support (F8.3) |
| GET | `/grants` | AFG/SAFER-style grant-support report (F8.4) |
| GET | `/response-times` | Turnout/travel/total analytics (F8.5) |
| GET | `/membership-trends` | Membership/attendance trends (F8.6) |
| GET | `/export` | CSV/PDF export, accept-and-queue for large ranges (F8.7) |
| GET | `/health/liveness` and `/health/readiness` | Health (none auth) |

## Data Ownership

None. Reads GSIs on the `platform-service` table only. "Reporting Projections" (a handler within this service, not CQRS) maintains DynamoDB rollup items on the shared `platform-service` table (pre-aggregated counters for the chief dashboard), not a separate read store.

## Events Produced

None.

## Events Consumed

- `personnel.attendance.recorded` — drives Reporting Projections rollups.

## Dependencies

Internal: `personnel-service`, `training-service`, `apparatus-service`, `inspections-service`, `incident-service` — all read via GSI on their shared/own tables, never a synchronous API call between services.

External: ElastiCache Valkey for chief-dashboard aggregations (5-15 min TTL, soft dependency, tolerant of staleness).

## Gotchas & Constraints

- No OpenSearch/CQRS in v1 — a genuine, explicit architecture decision, not an oversight. AOSS carries a standing cost floor disproportionate to this department's volume (dozens of members, low hundreds of incidents/year). Every read pattern this service needs (search, "expiring soon," map lookup, audit-by-member) is served by a GSI designed directly from the access pattern.
- Fast-follow trigger for CQRS (adopt Streams to OSI to AOSS): (a) a second department goes live and cross-department search is required, or (b) incident volume or full-text narrative search needs exceed what a GSI + FilterExpression over a few-thousand-item partition can serve interactively.
- No full-text narrative search exists in v1 (F7.4 narrative capture has no keyword-search access pattern) — acceptable at current volume, a real limitation if incident volume grows materially before the CQRS trigger fires.
- This service never caches anything that must reflect source-of-truth-at-read-time correctness (e.g., it must never be the source for "did this NERIS submission go out" — that's `incident-service`'s `NERIS_SUBMISSION_ATTEMPT`).

## Source Sections

- Backend Section 1.1 Service inventory (line 120-146, reporting-service row)
- Backend Section 1.4 Reporting read model rationale (line 268)
- Backend Section 2 reporting-service API endpoints, N-3 LOSAP dedup decision (line 386-398)
- Data Model Section 1, Section 5 No-OpenSearch rationale and fast-follow trigger (line 534-546, 1421-1432)
- Data Model Section 6 Caching — chief dashboard aggregations (line 1433-1443)
- Events Section 4 Service-name mapping, "Reporting Projections is not CQRS" (line 1527-1540)
- Risks and limitations item 7, no full-text search (line 1508)
