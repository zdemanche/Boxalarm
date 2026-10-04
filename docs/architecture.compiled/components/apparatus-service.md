# Apparatus Service

## Purpose & Boundaries
Apparatus registry, daily check sheets (glove-friendly, <90s target N4.2), defects with photo, out-of-service tracking, maintenance, SCBA, hose/ladder/pump/aerial testing schedules, compartment inventory, check compliance. Also hosts the riding board (alerting-plane, fail-open routes) used by crews during a call. Shares `platform` table; wave 2.

## Interfaces
GET `/api/v1/apparatus`, GET `/{unitId}`, GET `/{unitId}/checklist`, POST `/{unitId}/checks`, POST `/{unitId}/defects`, PUT `/{unitId}/defects/{defectId}/status` (admin; sets `status`, plus `resolvedAt`/`resolvedBy` on RESOLVED), PUT `/{unitId}/service-status` (admin), GET `/{unitId}/maintenance`, POST `/{unitId}/scba`, GET `/testing-schedules`, GET `/{unitId}/inventory`, GET `/compliance` (admin), health pair — all under `/api/v1/apparatus`. Riding board (alerting plane, Cognito, fail-open authorizer): GET `/api/v1/apparatus/riding-board/{dispatchId}`, POST `.../assignments`. Further routes (apparatus inventory writes) registered but untabulated.

## Data Ownership
APPARATUS `pk=DEPT#{deptId}#APPARATUS#{apparatusId}` `sk=METADATA` (status IN_SERVICE|OUT_OF_SERVICE; gsi3 `DEPT#{deptId}#APPARATUS`/`{unitId}`); CHECKLIST_TEMPLATE `pk=DEPT#{deptId}#CHECKLIST_TEMPLATE#{templateId}`; CHECKLIST_RUN `sk=CHECK#{completedAt}` (durationSeconds, capturedOffline, syncedAt; gsi3 `DEPT#{deptId}#CHECKLIST_RUN`); DEFECT `sk=DEFECT#{defectId}` (severity MINOR|MAJOR|OUT_OF_SERVICE; status OPEN|RESOLVED; gsi3 `DEPT#{deptId}#DEFECT`/`{status}#{reportedAt}`); OUT_OF_SERVICE_RECORD `sk=OOS#{startAt}`; MAINTENANCE_RECORD `sk=MAINT#{performedAt}`; SCBA_RECORD `pk=DEPT#{deptId}#SCBA#{scbaUnitId}` `sk=METADATA|TEST#{testDate}` (gsi2 `DUE#SCBA_TEST`); APPARATUS_TEST_RECORD `sk=TEST#{testType}#{testDate}` (HOSE|LADDER|PUMP|AERIAL; gsi2 `DUE#APPARATUS_TEST`); COMPARTMENT_ITEM `sk=COMPARTMENT_ITEM#{itemId}`. S3 photos `{deptId}/defect/{id}/...`. No TTL on CHECKLIST_RUN/MAINTENANCE/APPARATUS_TEST (ISO history).

## Events Produced
`apparatus.defect.reported` (outbox, on defect from a check; payload defectId, apparatusId, unitLabel, reportedByMemberId, severity, photoS3Key?, outOfService boolean, deptId -> `apparatus-notify-queue`+DLQ); `apparatus.test.due` (daily scanner; `{apparatusId, testType, dueDate}`); `apparatus.check.completed`.

## Events Consumed
absent — the source document does not address this (beyond mobile outbox replay).

## Dependencies
internal: notification-service (consumer), alerting-service (riding board dispatch context), mobile-app, web-console, platform-service. external: S3.

## Gotchas & Constraints
- Submit-check is TransactWriteItems of `CHECK#{ts}` + `DEFECT#{id}` per defect; offline-queued, replayed on reconnect with client idempotency key (N3.4).
- Riding-board routes are on the fail-open alerting authorizer set even though apparatus-owned.
- PUT defect status is last-writer-wins current-state.
- Defects route to apparatus officer via notification-service; no SMS/voice.

## Source Sections
Backend §1.1 (122-150); §2 apparatus-service (400-417) and riding board (345-346); Data Model APPARATUS..COMPARTMENT_ITEM (1168-1275); access patterns 27-34 (1484-1491); Events §1-reconciliation 7 (1640-1647)
