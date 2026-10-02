# Apparatus Service

## Purpose & Boundaries
Apparatus registry (F4.1), check sheets (F4.2, glove-friendly <90s, offline-capable), defects (F4.3), out-of-service (F4.4), maintenance (F4.5), SCBA (F4.6), testing schedules (F4.7), compartment inventory (F4.8), compliance (F4.9), plus the riding board for active dispatches (alerting-plane, fail-open routes).

## Interfaces
`/api/v1/apparatus`: GET `/`, `/{unitId}`, `/{unitId}/checklist`; POST `/{unitId}/checks`, `/{unitId}/defects`; PUT `/{unitId}/defects/{defectId}/status` (admin; sets `status`, and `resolvedAt`/`resolvedBy` on RESOLVED); PUT `/{unitId}/service-status` (admin); GET `/{unitId}/maintenance`; POST `/{unitId}/scba`; GET `/testing-schedules`, `/{unitId}/inventory`, `/compliance` (admin); GET `/riding-board/{dispatchId}`, POST `/riding-board/{dispatchId}/assignments` (Cognito, ALERTING_PLANE fail-open); health pair. Further unlisted routes (apparatus inventory writes) exist; authoritative registry = `infrastructure/components/api/http-api.ts`.

## Data Ownership
Platform table: `APPARATUS` (`pk=DEPT#{d}#APPARATUS#{apparatusId}`, METADATA; status IN_SERVICE|OUT_OF_SERVICE; gsi3 `DEPT#{d}#APPARATUS`/`{unitId}`), `CHECKLIST_TEMPLATE` (`DEPT#{d}#CHECKLIST_TEMPLATE#{id}`), `CHECKLIST_RUN` (`CHECK#{completedAt}`, durationSeconds, capturedOffline, gsi3 `DEPT#{d}#CHECKLIST_RUN`), `DEFECT` (`DEFECT#{defectId}`; severity MINOR|MAJOR|OUT_OF_SERVICE; status OPEN|RESOLVED; gsi3 `DEPT#{d}#DEFECT`/`{status}#{reportedAt}`), `OUT_OF_SERVICE_RECORD` (`OOS#{startAt}`), `MAINTENANCE_RECORD` (`MAINT#{performedAt}`), `SCBA_RECORD` (`pk=DEPT#{d}#SCBA#{id}`; gsi2 due), `APPARATUS_TEST_RECORD` (`TEST#{testType}#{date}`; HOSE|LADDER|PUMP|AERIAL), `COMPARTMENT_ITEM`.

## Events Produced
`apparatus.defect.reported` `{defectId, apparatusId, unitLabel, reportedByMemberId, severity, photoS3Key?, outOfService, deptId}` (outbox) -> `apparatus-notify-queue`; `apparatus.test.due` `{apparatusId, testType, dueDate}` (daily scanner); `apparatus.check.completed`.

## Events Consumed
absent — the source document does not address this

## Dependencies
internal: alerting-service (riding board), notification-service. external: S3 (photos), DynamoDB.

## Gotchas & Constraints
- Submit-check is one `TransactWriteItems` (CHECK + DEFECT per defect), offline-queued, replayed with client idempotency key (N3.4).
- CHECKLIST_RUN/MAINTENANCE/TEST records have no TTL (ISO compliance history).
- Test-matrix: F4.3n and F4.7n notification rows required.
- Riding-board routes are fail-open: must remain in `ALERTING_PLANE_ROUTES`.

## Source Sections
§1.1 122–150; §2 apparatus API 400–417 and riding board 345–346; Data Model apparatus entities 1168–1275; AP 27–34 1484–1491; Testing F4 2345–2357.
