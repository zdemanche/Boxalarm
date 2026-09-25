# platform-service

## Purpose & Boundaries

Cognito triggers, department configuration (F9.3), Verified Permissions policy admin, cross-service audit log sink (F9.4), full data export (F9.5). Service 2 of 10, Wave 1. Also the **physical DynamoDB table owner** for 7 other logical services (personnel, apparatus, training, reporting-read-model, inspections, inventory, notification) — a deliberate deviation from one-table-per-service since these share one operational lifecycle (general CRUD/config) with no independent scaling need.

## Interfaces

Base path `/api/v1/platform/...`.

| Method | Path | Description | Auth |
|---|---|---|---|
| GET | `/config` | Department config: apparatus, stations, ranks, point rules, checklists, alert rules (F9.3) | Cognito(admin) |
| PUT | `/config` | Update config. **Obligation:** `configType=ALERT_RULES` write must reject `requiredQuals` naming a qual no currently-eligible member holds (validator not designed, named obligation) | Cognito(admin) |
| GET | `/audit` | Cross-service record-mutation audit log (F9.4) | Cognito(admin) |
| POST | `/export` | Request full data export job, accept-and-queue (F9.5) | Cognito(admin) |
| GET | `/export/{jobId}` | Export job status + download link | Cognito(admin) |
| GET | `/health/liveness` \| `/health/readiness` | Health | none |

## Data Ownership

Physical table `platform-service` (shared, on-demand, PITR on, Streams on, AWS-managed KMS key — cost grounds, unlike alerting/incident's customer-managed key). Three generic GSI roles used across all entities on this table: **GSI1** "my records" (`gsi1pk=MEMBER#{memberId}`), **GSI2** "due within window" (`gsi2pk=DEPT#{deptId}#DUE#{entityType}#{YYYY-MM}`, month-bucketed), **GSI3** "department lists/geo/audit-by-entity" (`gsi3pk=DEPT#{deptId}#{entityType}[#GEO#{geohash5}|#ADDR#{normalizedAddress}]`).

- **DEPARTMENT_CONFIG** — `pk=DEPT#{deptId}`, `sk=CONFIG#{configType}` (`STATIONS`|`RANKS`|`LOSAP_POINT_RULES`|`ALERT_RULES`|`CHECKLIST_DEFAULTS`|`retention`). `version` optimistic-lock counter. Read-mostly, Valkey caching candidate.
- **AUDIT_LOG_ENTRY** (F9.4) — `pk=DEPT#{deptId}#AUDIT#{YYYY-MM-DD}` (daily-bucketed), `sk={ts}#{entityType}#{entityId}#{actorId}`. `changedFields` inherits PII classification from the audited entity. No TTL; export-to-S3 archival after 2 years.
- **NOTIFICATION_PREFERENCE** / **NOTIFICATION** — see notification-service sheet (owned logically by notification-service, physically on this table).

## Events Produced

- `platform.config.alert_rules.updated` — outbox pattern, on `PUT /config` write with `configType=ALERT_RULES`. Crosses **into** the alerting plane (sanctioned direction). Consumer: `alerting-service`'s `ALERT_RULES_COPY` maintainer. Transport: `boxalarm-{env}-platform-bus` → `alert-rules-copy-queue` + DLQ, `maxReceiveCount: 5`.
- Outbox pattern used generally for every write that must also raise an event (write + outbox row in one DynamoDB transaction; Streams-triggered Lambda publishes and marks sent).

## Events Consumed

None directly (platform-service is largely a producer/sink for config and audit).

## Dependencies

**Internal:** consumed by every other LOB service for config reads (Valkey-fronted, §6) and audit-entry writes. `alerting-service` consumes `platform.config.alert_rules.updated` only (event-driven, never a synchronous read — C-2 isolation invariant is enforced by IAM on alerting-service's side).

**External:** ElastiCache Serverless Valkey (config caching, `platform-service:dept-config:{deptId}#{configType}`, 5 min TTL, soft dependency).

## Gotchas & Constraints

- **`POST /platform/export` is the one sanctioned exception to the alerting isolation invariant** — it runs under a dedicated read-only role with read access to all three physical tables (the only principal outside alerting-service holding any alerting-table permission). Cedar chief/admin-gated, **no re-authentication challenge** (per session policy), and **alarmed on every single invocation**, not just on volume.
- **No MFA, no step-up, no session timeout anywhere** — export and destructive admin actions are gated by a Cedar role check alone. A valid session on a chief/admin account is, by itself, sufficient to export every member's PII/LOSAP/incident history. Controls that remain are detection and reversal (alarms, audit, revocation), never prevention.
- **`PUT /platform/config` with `configType=ALERT_RULES` must reject an impossible `requiredQuals` predicate** (naming a qual no eligible member holds) — unvalidated, this fires mutual aid on every dispatch of that call type. Validator is a named, not-yet-designed obligation.
- **GSI3's low-cardinality list partitions are an accepted, documented tradeoff** at single-department scale (one partition per department per entity type) — resharding path (suffix or geohash) named if a second department pools cross-department lists or any entity type exceeds ~50k items.
- **DEPARTMENT_CONFIG gains a `retention` configType** so N6.3's "configurable to CT/municipal requirements" has an actual configuration surface (not yet populated — CT rules unresolved, OQ-19).

## Source Sections

- Backend §1.1 Service inventory, service-to-table mapping (`:120-146`)
- Backend §2 platform-service API endpoints (`:300-311`)
- Data Model §1, §3.3 (MEMBER GSI roles, DEPARTMENT_CONFIG, AUDIT_LOG_ENTRY) (`:534-546`, `:925-1320`)
- Data Model §6 Caching (`:1433-1443`)
- Events §Producer/consumer table, `platform.config.alert_rules.updated` (`:1766-1821`)
- Cross-Cutting: Data Protection — export IAM path, anomalous access monitoring, session policy (`:2617-2629`)
- Cross-Cutting: Security & Auth (`:2631-2649`)
