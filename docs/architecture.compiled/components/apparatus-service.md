# apparatus-service

## Purpose & Boundaries
Apparatus registry, check sheets, defects, out-of-service tracking, maintenance, SCBA, testing schedules, compartments. Wave 2. Data on the shared `platform-service` table.

## Interfaces
Base path `/api/v1/apparatus/...`.

| Method | Path | Description | Auth |
|---|---|---|---|
| GET | `/` | Apparatus registry (F4.1) | Cognito |
| GET | `/{unitId}` | Apparatus detail incl. in/out-of-service status | Cognito |
| GET | `/{unitId}/checklist` | Today's configurable check sheet (F4.2) | Cognito |
| POST | `/{unitId}/checks` | Submit completed check, glove-friendly, <90s target (N4.2) | Cognito |
| POST | `/{unitId}/defects` | Report defect with photo, routed to apparatus officer (F4.3) | Cognito |
| PUT | `/{unitId}/service-status` | Out-of-service with reason/duration (F4.4) | Cognito(admin) |
| GET | `/{unitId}/maintenance` | Maintenance history + scheduled (F4.5) | Cognito |
| POST | `/{unitId}/scba` | SCBA record: unit/cylinder/flow test/hydro (F4.6) | Cognito |
| GET | `/testing-schedules` | Hose/ladder/pump/aerial due dates (F4.7) | Cognito |
| GET | `/{unitId}/inventory` | Compartment inventory (F4.8) | Cognito |
| GET | `/compliance` | Check compliance report (F4.9) | Cognito(admin) |

## Data Ownership
On the shared `platform-service` table.

- **APPARATUS** — `pk=DEPT#{deptId}#APPARATUS#{apparatusId}`, `sk=METADATA`. `status` IN_SERVICE|OUT_OF_SERVICE. `gsi3pk/sk` = `DEPT#{deptId}#APPARATUS` / `{unitId}`.
- **CHECKLIST_TEMPLATE** — `pk=DEPT#{deptId}#CHECKLIST_TEMPLATE#{templateId}`. `items[]` = `{code, label, requiresPhoto}` — F9.3 department-configurable.
- **CHECKLIST_RUN** — `pk=DEPT#{deptId}#APPARATUS#{apparatusId}`, `sk=CHECK#{completedAt}`. `durationSeconds` feeds N4.2 (<90s) monitoring. `capturedOffline`/`syncedAt` for N3.4.
- **DEFECT** — `sk=DEFECT#{defectId}`. `severity` MINOR|MAJOR|OUT_OF_SERVICE. `gsi3pk/sk` = `DEPT#{deptId}#DEFECT` / `{status}#{reportedAt}`.
- **OUT_OF_SERVICE_RECORD** — `sk=OOS#{startAt}`.
- **MAINTENANCE_RECORD** — `sk=MAINT#{performedAt}`.
- **SCBA_RECORD** — `pk=DEPT#{deptId}#SCBA#{scbaUnitId}`, `sk=METADATA`|`TEST#{testDate}`. `gsi2pk/sk` = `DEPT#{deptId}#DUE#SCBA_TEST#{YYYY-MM}` / `{dueDate}#{scbaUnitId}`.
- **APPARATUS_TEST_RECORD** — `sk=TEST#{testType}#{testDate}`, `testType` HOSE|LADDER|PUMP|AERIAL. `gsi2pk/sk` = `DEPT#{deptId}#DUE#APPARATUS_TEST#{YYYY-MM}` / `{nextDueDate}#{apparatusId}#{testType}`.
- **COMPARTMENT_ITEM** — `sk=COMPARTMENT_ITEM#{itemId}`.

No TTL on `CHECKLIST_RUN`, `MAINTENANCE_RECORD`, `APPARATUS_TEST_RECORD` — compliance/ISO history must persist.

## Events Produced
- `apparatus.defect.reported` — outbox, on defect creation from a check (F4.3). Producer: `apparatus-service`. Consumer: `notification-service` (routes to apparatus officer role). Transport: `boxalarm-{env}-platform-bus` rule → `apparatus-notify-queue` + DLQ. Payload: `{defectId, apparatusId, unitLabel, reportedByMemberId, severity, photoS3Key?, outOfService: boolean, deptId}`.
- `apparatus.test.due` — Apparatus Testing Scanner (daily scheduled Lambda). `{apparatusId, testType, dueDate}`. Consumer: `notification-service`. Transport: platform-bus → `apparatus-notify-queue`.
- `apparatus.check.completed` (dotted form of `CheckCompleted` shorthand referenced elsewhere in the source) — no payload shape given in the source document; use as event-type naming reference only.

## Events Consumed
None named.

## Dependencies
**Internal:** publishes to `notification-service` (defect routing, testing-due). Referenced by `alerting-service` only via hydrant/pre-plan ID references at the incident layer, not directly.
**External:** none.

## Gotchas & Constraints
- **F4.2 check submission has a hard <90s performance target (N4.2)** — no step in the checklist should wait on a server response; the mobile client writes local-first (optimistic) and syncs via outbox. Measured against a realistic checklist length per department config, not a toy fixture.
- **Offline-capable, must be idempotent on sync replay.** Truck checks (F4.2) and defect reports (F4.3) are in-scope for the offline sync strategy (N3.4); each outbox entry carries a client-generated idempotency key so a retried push after partial failure cannot double-submit a check or defect.
- **F4.3 was the requirement that first exposed the missing `notification-service` capability** — `apparatus.defect.reported` did not exist prior to reconciliation; without it, defect routing to the apparatus officer would not be deliverable end to end.
- Checks and inspections are treated as append-only submissions (timestamped record, not editable shared document) — last-write-wins conflicts are structurally rare here, unlike shift claims.
- GSI3's apparatus/defect list-style partitions are a deliberate, accepted low-cardinality tradeoff at this department's data volume (bounded low thousands, human-paced writes) — reshard with a `#SHARD#{n}` suffix only if a single entity type exceeds ~50k items or cross-department pooling activates.

## Source Sections
- Backend §1.1 Bounded contexts / service table — lines 116–142
- API endpoints: apparatus-service — lines 305–319
- Data Model §3.3 APPARATUS, CHECKLIST_TEMPLATE, CHECKLIST_RUN, DEFECT, OUT_OF_SERVICE_RECORD, MAINTENANCE_RECORD, SCBA_RECORD, APPARATUS_TEST_RECORD, COMPARTMENT_ITEM — lines 924–1031
- Data Model §3.4 Retention/TTL — lines 1164–1175
- Data Model §4 Access patterns #27–34 — lines 1209–1217
- Events §7 New notification-service events (apparatus.defect.reported) — lines 1337–1345
- Events §3, §5 (apparatus.test.due producer/consumer/transport) — lines 1398–1420, 1503–1522
- Frontend §9 Offline and sync strategy — lines 1779–1787
- Testing §2 F4 test matrix — lines 1936–1948
