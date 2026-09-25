# apparatus-service

## Purpose & Boundaries

Apparatus registry, check sheets, defects, out-of-service tracking, maintenance, SCBA, testing schedules, compartments. Service 4 of 10, Wave 2. Logical service on the shared `platform-service` physical table.

## Interfaces

Base path `/api/v1/apparatus/...`.

| Method | Path | Description | Auth |
|---|---|---|---|
| GET | `/` | Apparatus registry (F4.1) | Cognito |
| GET | `/{unitId}` | Apparatus detail incl. in/out-of-service status | Cognito |
| GET | `/{unitId}/checklist` | Today's configurable check sheet (F4.2) | Cognito |
| POST | `/{unitId}/checks` | Submit completed check, glove-friendly, <90s target (N4.2) | Cognito |
| POST | `/{unitId}/defects` | Report defect w/ photo, routed to apparatus officer (F4.3) | Cognito |
| PUT | `/{unitId}/defects/{defectId}/status` | Resolve/reopen defect — sets `status`, `resolvedAt`/`resolvedBy` on transition to `RESOLVED` | Cognito(admin) |
| PUT | `/{unitId}/service-status` | Out-of-service w/ reason/duration (F4.4) | Cognito(admin) |
| GET | `/{unitId}/maintenance` | Maintenance history + scheduled (F4.5) | Cognito |
| POST | `/{unitId}/scba` | SCBA record: unit/cylinder/flow test/hydro (F4.6) | Cognito |
| GET | `/testing-schedules` | Hose/ladder/pump/aerial due dates (F4.7) | Cognito |
| GET | `/{unitId}/inventory` | Compartment inventory (F4.8) | Cognito |
| GET | `/compliance` | Check compliance report (F4.9) | Cognito(admin) |
| GET | `/health/liveness` \| `/health/readiness` | Health | none |

## Data Ownership

On `platform-service` physical table.

- **APPARATUS** — `pk=DEPT#{deptId}#APPARATUS#{apparatusId}`, `sk=METADATA`. `status`: `IN_SERVICE`|`OUT_OF_SERVICE`.
- **CHECKLIST_TEMPLATE** — `pk=DEPT#{deptId}#CHECKLIST_TEMPLATE#{templateId}`. `items`: `{code, label, requiresPhoto}`.
- **CHECKLIST_RUN** — `sk=CHECK#{completedAt}`. `durationSeconds` feeds N4.2 (<90s) monitoring. `capturedOffline`, `syncedAt` (N3.4 offline support).
- **DEFECT** — `sk=DEFECT#{defectId}`. `severity`: `MINOR`|`MAJOR`|`OUT_OF_SERVICE`. `status`: `OPEN`|`RESOLVED`.
- **OUT_OF_SERVICE_RECORD** — `sk=OOS#{startAt}`.
- **MAINTENANCE_RECORD** — `sk=MAINT#{performedAt}`.
- **SCBA_RECORD** — `pk=DEPT#{deptId}#SCBA#{scbaUnitId}`, `sk=METADATA`|`TEST#{testDate}`.
- **APPARATUS_TEST_RECORD** — `sk=TEST#{testType}#{testDate}`. `testType`: `HOSE`|`LADDER`|`PUMP`|`AERIAL`.
- **COMPARTMENT_ITEM** — `sk=COMPARTMENT_ITEM#{itemId}`.

No TTL on `CHECKLIST_RUN`/`MAINTENANCE_RECORD`/`APPARATUS_TEST_RECORD` — ISO/F4.9 compliance history required.

## Events Produced

- `apparatus.test.due` — daily scheduled Lambda scanner → `notification-service`.
- `apparatus.defect.reported` — outbox, on defect creation from a check (F4.3) → `notification-service` (routes to apparatus officer role). Transport: `boxalarm-{env}-platform-bus` → `apparatus-notify-queue` + DLQ. Payload: `defectId`, `apparatusId`, `unitLabel`, `reportedByMemberId`, `severity`, `photoS3Key?`, `outOfService`, `deptId`.
- `apparatus.check.completed` — canonical dotted form of the legacy `CheckCompleted` shorthand.

## Events Consumed

None named directly.

## Dependencies

**Internal:** `notification-service` (defect/testing-due routing). No synchronous calls to/from alerting-service.

**External:** S3 (`nichols-boxalarm-platform-assets` bucket) for defect/checklist photos.

## Gotchas & Constraints

- **`apparatus.defect.reported` was previously undefined** — F4.3 was the requirement that first exposed the missing notification capability; without this event the requirement was not deliverable end to end. Now defined with producer/consumer/transport/payload.
- **90-second check-completion budget (N4.2) is a measured performance assertion**, checked against a realistic-length checklist (department-configured), not a 3-item toy fixture — no server round-trip may gate any step in the checklist (offline-first write).
- **Defect status transitions are decided (N-9):** `PUT /{unitId}/defects/{defectId}/status` sets `status` and `resolvedAt`/`resolvedBy` only on transition to `RESOLVED` — no separate history entity.

## Source Sections

- Backend §1.1 Service inventory (`:120-146`)
- Backend §2 apparatus-service API endpoints (`:335-352`)
- Data Model §3.3 APPARATUS through COMPARTMENT_ITEM (`:1081-1188`)
- Data Model §3.4 Retention (`:1321-1333`)
- Data Model §4 Access patterns 27-34 (`:1394-1402`)
- Events §7 new events table, `apparatus.defect.reported` (`:1548-1556`)
- Events §Other domains, producer/consumer table (`:1787-1817`)
