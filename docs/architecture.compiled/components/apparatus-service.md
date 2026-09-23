# apparatus-service

## Purpose & Boundaries
Apparatus registry, configurable check sheets, defect reporting/routing, out-of-service tracking, maintenance, SCBA records, testing schedules, and compartment inventory.

## Interfaces
Base path `/api/v1/apparatus/...`.

| Method | Path | Auth |
|---|---|---|
| GET | `/` (registry) | Cognito |
| GET | `/{unitId}` | Cognito |
| GET | `/{unitId}/checklist` | Cognito |
| POST | `/{unitId}/checks` (glove-friendly, <90s target, N4.2) | Cognito |
| POST | `/{unitId}/defects` (with photo, routed to apparatus officer) | Cognito |
| PUT | `/{unitId}/service-status` | Cognito(admin) |
| GET | `/{unitId}/maintenance` | Cognito |
| POST | `/{unitId}/scba` | Cognito |
| GET | `/testing-schedules` | Cognito |
| GET | `/{unitId}/inventory` (compartments) | Cognito |
| GET | `/compliance` | Cognito(admin) |

## Data Ownership
On the shared `platform-service` table:
- `APPARATUS` — `pk=DEPT#{deptId}#APPARATUS#{apparatusId}`, `status: IN_SERVICE|OUT_OF_SERVICE`.
- `CHECKLIST_TEMPLATE` — configurable per F9.3, `applicableApparatusIds`, `items[{code,label,requiresPhoto}]`.
- `CHECKLIST_RUN` — `sk=CHECK#{completedAt}`, `durationSeconds` feeds N4.2 monitoring, `capturedOffline: Boolean`.
- `DEFECT` — `sk=DEFECT#{defectId}`, `severity: MINOR|MAJOR|OUT_OF_SERVICE`, `photoS3Key`.
- `OUT_OF_SERVICE_RECORD`, `MAINTENANCE_RECORD` — `sk=OOS#{startAt}` / `MAINT#{performedAt}`.
- `SCBA_RECORD` — `pk=DEPT#{deptId}#SCBA#{scbaUnitId}`, flow/hydro test due dates on GSI2.
- `APPARATUS_TEST_RECORD` — `sk=TEST#{testType}#{testDate}`, `testType: HOSE|LADDER|PUMP|AERIAL`.
- `COMPARTMENT_ITEM` — `sk=COMPARTMENT_ITEM#{itemId}`.
- No TTL on `CHECKLIST_RUN`/`MAINTENANCE_RECORD`/`APPARATUS_TEST_RECORD` — ISO/compliance history.

## Events Produced
- `apparatus.test.due` (daily scheduled scanner) → `notification-service`.
- `apparatus.defect.reported` (amendment, previously undefined) — outbox, on defect creation from a check → `notification-service` (routes to apparatus officer role). Payload: `defectId, apparatusId, unitLabel, reportedByMemberId, severity, photoS3Key?, outOfService, deptId`.
- `apparatus.check.completed` (dotted form of `CheckCompleted`).

## Events Consumed
None specific beyond outbox self-publication.

## Dependencies
- **Internal**: `notification-service` (defect-routing, testing-due notifications), `inventory-service` (equipment/PPE assignment is a separate service but shares the physical table for compartment/equipment queries).
- **External**: none named.

## Gotchas & Constraints
- Offline-tolerant writes: `CHECKLIST_RUN`/`DEFECT` submission is queued offline and replayed on reconnect per N3.4 — replay must not double-apply (same idempotency discipline as alerting's exactly-once, applied to sync).
- F4.2 truck check has a hard 90-second performance budget (N4.2) — tested as a timed flow, not a vibe; checked against a realistic checklist length, not a 3-item toy fixture.
- `apparatus.defect.reported` was the event that first exposed the missing `notification-service` capability — without it, F4.3 would not have been deliverable end to end.

## Source Sections
- Backend §1.1 Bounded contexts (service #4), lines 118-142
- API endpoints, apparatus-service, lines 328-342
- Data Model §3.3 APPARATUS through COMPARTMENT_ITEM, lines 1028-1135
- Eventing §3, item 7 (notification-service events table), lines 1449-1456, 1520-1544
- Testing §2 F4 matrix, lines 2130-2143
