# platform-service

## Purpose & Boundaries
Cognito triggers, department configuration, Verified Permissions policy admin, cross-service mutation audit log sink, full data export. Wave 1. Owns the shared `platform-service` DynamoDB table used by 8 of the 10 services (everything except `alerting-service` and `incident-service`). Holds the one sanctioned exception to the alerting isolation invariant: `POST /platform/export`'s dedicated read-only role, which is the only principal outside `alerting-service` with any permission on the alerting table.

## Interfaces
Base path `/api/v1/platform/...`.

| Method | Path | Description | Auth |
|---|---|---|---|
| GET | `/config` | Department configuration: apparatus, stations, ranks, point rules, checklists, alert rules (F9.3) | Cognito(admin) |
| PUT | `/config` | Update department configuration | Cognito(admin) |
| GET | `/audit` | Cross-service record-mutation audit log (F9.4) | Cognito(admin) |
| POST | `/export` | Request full data export job — accept-and-queue (F9.5) | Cognito(admin) |
| GET | `/export/{jobId}` | Export job status + download link | Cognito(admin) |
| GET | `/health/liveness` | Liveness | none |
| GET | `/health/readiness` | Readiness | none |

## Data Ownership
Shared `platform-service` DynamoDB table (on-demand, PITR on, Streams on — feeds future CQRS and possibly F2.12/F3.7 side-effect propagation), AWS-managed KMS key (cost grounds — not customer-managed, unlike alerting/incident tables). This sheet covers only the entities `platform-service` itself owns; other tenants of this physical table (members, apparatus, occupancies, etc.) are documented on their owning services' sheets even though they live in the same table.

- **DEPARTMENT_CONFIG** — `pk=DEPT#{deptId}`, `sk=CONFIG#{configType}` (`STATIONS`|`RANKS`|`LOSAP_POINT_RULES`|`ALERT_RULES`|`CHECKLIST_DEFAULTS`, plus a `retention` configType for N6.3 configurability). `version` = optimistic-lock/cache-bust counter. Read-mostly — the canonical Valkey caching candidate (5 min TTL).
- **AUDIT_LOG_ENTRY** — `pk=DEPT#{deptId}#AUDIT#{YYYY-MM-DD}` (daily-bucketed for cardinality), `sk={ts}#{entityType}#{entityId}#{actorId}`. `changedFields` = before/after map. No TTL — export-to-S3 archival after 2 years to control size, never deleted outright without a retention decision. GSI3 `...#AUDIT#ENTITY#{type}#{id}` serves "who changed this record."
- **OUTBOX_ENTRY** (per-service pattern, applies here too) — `pk=OUTBOX#{aggregateId}`, `sk=EVT#{eventId}`. TTL 7 days after `sentAt`.

Generic GSI roles on the shared table (used by every co-tenant service): **GSI1** "my records" (`gsi1pk=MEMBER#{memberId}`); **GSI2** "due within window" (`gsi2pk=DEPT#{deptId}#DUE#{entityType}#{YYYY-MM}`, month-bucketed); **GSI3** "department lists / geo / audit-by-entity" (`gsi3pk=DEPT#{deptId}#{entityType}[#GEO#{geohash5}|#ADDR#{normalizedAddress}]`).

## Events Produced
Outbox pattern for the audit sink (per house standard: write + outbox row in one transaction, Streams-triggered publisher). No specific audit event type is named in the source document beyond the general envelope.

## Events Consumed
Implicitly all mutation events across the LOB plane feed the audit sink via the outbox-driven `AuditEvent` stream (F9.4) — the source document does not enumerate a specific consumed-event list for `platform-service` itself beyond this general mechanism.

## Dependencies
**Internal:** none synchronous — reads/writes are local to the shared table. Every other LOB service co-tenants this table (`personnel-service`, `apparatus-service`, `training-service`, `inspections-service`, `inventory-service`, `notification-service`, `reporting-service` reads its GSIs).
**External:** none directly.

## Gotchas & Constraints
- **`POST /platform/export` is the one sanctioned exception to the alerting isolation invariant** — its dedicated role has read-only access to all three tables (alerting, incident, platform). Cedar chief/admin-gated, **no re-authentication challenge** (see Auth below), and alarmed on **every invocation**, not just on volume.
- **No MFA, no step-up re-authentication anywhere in this service — including export and destructive admin actions.** Access control on `/platform/export` and any destructive admin action is a Cedar chief/admin role check alone, evaluated via `IsAuthorizedWithToken`, fail-secure (503, never a defaulted allow). A valid chief/admin session is by itself sufficient to export all member PII, LOSAP records, and incident history. This is a deliberate, documented product decision (see spine Cross-Cutting → Auth) — do not add MFA, a password re-entry prompt, or any step-up flow to this service.
- Compensating control: the export-invocation alarm is the **primary** control on this surface, not secondary — it detects, it does not prevent.
- Disposal (N6.3 records-retention) is **verified hard delete** for LOB records and **crypto-shredding** (KMS key destruction) for archived incident/delivery-receipt classes; the S3-Glacier archival job itself is assigned to Wave 3 — until it ships, `AUDIT_LOG_ENTRY` storage grows unbounded (acceptable only at this department's volume).
- `DEPARTMENT_CONFIG` is the canonical Valkey caching target (5 min TTL) — never cache `AUDIT_LOG_ENTRY` or anything export-related.
- Fail-secure authorization applies to this service without the alerting-plane carve-out — every endpoint here goes through the Cognito authorizer + Verified Permissions.

## Source Sections
- Backend §1.1 Bounded contexts / service table — lines 116–142
- Backend §1.1 Service-to-table mapping (reconciled) — line 142
- API endpoints: platform-service — lines 271–282
- Data Model §1 Summary recommendation — lines 465–477
- Data Model §3.3 platform-service table header + GSI roles — lines 768–779
- Data Model §3.3 DEPARTMENT_CONFIG, AUDIT_LOG_ENTRY — lines 1135–1163
- Data Model §4 Access patterns #41–43, #51 — lines 1224–1234
- Data Model §6 Caching — lines 1248–1259
- Events §6 Outbox/dedup tables — lines 1330–1336
- Cross-Cutting → Data Protection (export IAM path, anomalous access monitoring, retention/disposal) — lines 2296–2308
- Cross-Cutting → Session and re-authentication policy (CANONICAL) — line 2302
- Cross-Cutting → Security & Auth (cost of the no-step-up decision) — lines 2310–2323
