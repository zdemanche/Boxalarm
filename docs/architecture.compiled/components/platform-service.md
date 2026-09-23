# platform-service

## Purpose & Boundaries
Cognito triggers, department configuration (`ALERT_RULES`, `LOSAP_POINT_RULES`, `STATIONS`, `RANKS`, `CHECKLIST_DEFAULTS`, `retention`), Verified Permissions policy admin, cross-service audit-log sink (F9.4), and full data export (F9.5). Also the physical DynamoDB table shared by 8 of the 10 service code boundaries (everything except `alerting-service` and `incident-service`) — general CRUD/config domain with no independent scaling or availability requirement.

## Interfaces
Base path `/api/v1/platform/...`.

| Method | Path | Auth |
|---|---|---|
| GET / PUT | `/config` | Cognito(admin) — `PUT` with `configType=ALERT_RULES` must reject `requiredQuals` naming a qual code no eligible member holds (validator not designed, named obligation) |
| GET | `/audit` | Cognito(admin) |
| POST | `/export` (accept-and-queue) | Cognito(admin), Cedar-gated alone, no re-auth challenge, alarmed on every invocation |
| GET | `/export/{jobId}` | Cognito(admin) |
| GET | `/health/liveness` \| `/health/readiness` | none |

## Data Ownership
The `platform-service` DynamoDB table (on-demand, PITR, Streams on). Owns `MEMBER`, `MEMBER_QUALIFICATION`, `CERTIFICATION`, `ATTENDANCE_RECORD`, `LOSAP_POINT_ENTRY`, `AVAILABILITY_MARKOFF`, `DUTY_SHIFT`, `SHIFT_POSITION`, `SHIFT_SWAP_REQUEST`, `TRAINING_EVENT`, `TRAINING_ATTENDANCE`, `APPARATUS`, `CHECKLIST_TEMPLATE`, `CHECKLIST_RUN`, `DEFECT`, `OUT_OF_SERVICE_RECORD`, `MAINTENANCE_RECORD`, `SCBA_RECORD`, `APPARATUS_TEST_RECORD`, `COMPARTMENT_ITEM`, `EQUIPMENT_ASSET`, `PPE_ASSIGNMENT`, `CONSUMABLE_STOCK`, `OCCUPANCY`, `PRE_PLAN`, `INSPECTION_RECORD`, `HYDRANT`, `DEPARTMENT_CONFIG`, `AUDIT_LOG_ENTRY`, `NOTIFICATION_PREFERENCE`, `NOTIFICATION` (this sheet covers the config/audit/export entities directly owned by `platform-service`'s own bounded context; other entities on this shared table are documented under their owning service sheet).
- `DEPARTMENT_CONFIG` — `pk=DEPT#{deptId}`, `sk=CONFIG#{configType}`. `version` field = optimistic-lock/cache-bust counter. Read-mostly, Valkey-cached (5 min TTL).
- `AUDIT_LOG_ENTRY` — `pk=DEPT#{deptId}#AUDIT#{YYYY-MM-DD}` (daily-bucketed), `sk={ts}#{entityType}#{entityId}#{actorId}`. No TTL; export-to-S3 archival after 2 years, never deleted outright.
- Generic GSIs used across this table: GSI1 "my records" (`gsi1pk=MEMBER#{memberId}`), GSI2 "due within window" (month-bucketed, `gsi2pk=DEPT#{deptId}#DUE#{entityType}#{YYYY-MM}`), GSI3 "department lists/geo/audit-by-entity".

## Events Produced
- Outbox pattern for every write needing an event. `platform.config.alert_rules.updated` (new, amendment) — outbox, on `PUT /platform/config` with `configType=ALERT_RULES`; payload = the full `ALERT_RULES_COPY` shape.
- Audit sink: outbox-driven `AuditEvent` stream feeding F9.4.

## Events Consumed
None specific to this sheet beyond receiving Cognito triggers directly (not eventing).

## Dependencies
- **Internal**: `alerting-service` (one-way consumer of `platform.config.alert_rules.updated`; also the sole external reader of the alerting/incident tables via the dedicated export role). `personnel-service`, `apparatus-service`, `training-service`, `inspections-service`, `inventory-service`, `notification-service`, `reporting-service` all share this physical table with their own entity sets.
- **External**: Amazon Cognito (identity provider, triggers), AWS Verified Permissions (Cedar policy store).

## Gotchas & Constraints
- The physical table is shared across 8 service code boundaries — a deliberate, named deviation from the Moonaan one-table-per-service default, taken on cost-floor and shared-lifecycle grounds. Service code boundaries remain 10; do not conflate physical table sharing with a merger of bounded contexts.
- `PUT /platform/config` with `configType=ALERT_RULES` carries a config-validation obligation this document records but does not design: reject any `requiredQuals` qualification code no currently-eligible member holds.
- Export runs under a dedicated read-only IAM role with read access to all three tables (the one sanctioned exception to the alerting-isolation invariant) — Cedar chief/admin-gated, no re-authentication challenge, alarmed on every invocation, not merely on volume.
- GSI3's list-style partitions (e.g. `DEPT#NICHOLS#APPARATUS`) are a deliberate, documented low-cardinality exception — correct at one department's volume; reshard with a `#SHARD#{n}` suffix if a second department pools data or any entity type exceeds ~50k items.
- `AUDIT_LOG_ENTRY` and `DELIVERY_RECEIPT` (in `alerting-service`) are the two records the product will be judged by — CloudTrail data events enabled, archived to S3 with Object Lock (compliance mode), IAM write path separated from the services whose mutations they record.

## Source Sections
- Backend §1.1 Bounded contexts (service #2) and table-mapping reconciliation, lines 118-142
- API endpoints, platform-service, lines 294-305
- Data Model §1 Summary recommendation, lines 488-501
- Data Model §3.3 platform-service table (config/audit portion), lines 872-883, 1239-1267
- Eventing §4.1 `platform.config.alert_rules.updated`, lines 1647-1662
- Cross-Cutting → Data Protection (export IAM path, anomalous access monitoring, retention/disposal), lines 2494-2507
- Cross-Cutting → Security & Auth, lines 2508-2526
