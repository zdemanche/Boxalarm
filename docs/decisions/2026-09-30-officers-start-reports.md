# 2026-09-30: Officers start incident reports (feat/owed-stories)

## Decision

Officers may start incident reports. `POST /api/v1/incidents` (`incident-service/createIncident.ts`) is gated by the Cedar action `CreateIncidentReport` in the NERIS officer tier (OFFICER, CHIEF, ADMIN). That is the same tier as `LockIncidentReport`, `SubmitIncidentReport` and `ResubmitIncidentReport`, and as `ListRecentDispatches`, the "Start a report" dispatch list.

**Why:**
- The officer already completes, locks and submits the NERIS report. That is the PRD's flow, in which the officer completes and files the report (F7). Refusing only the first step made no sense.
- The web already showed officers "Start report", and the server answered with a 403.
- Before this change, create was a hand-rolled CHIEF/ADMIN `cognito:groups` check. It is now a declared Cedar action that the policy store covers and the handler checks through `withAuthorization`. A MEMBER, TRAINING or APPARATUS caller gets a 403 before any read.

**Surfaces:**
- **Web:** `canStartIncidentReport` (`ui/apps/web/src/auth/roles.ts`) decides who sees Start.
- **Mobile:** Alerts → "Start a report" gives the Start button to OFFICER, CHIEF and ADMIN.

## Dispatch copies from before the list

`GET /api/v1/incidents/dispatches` lists incident-service's own dispatch copies through GSI1 keys that `putDispatchAlertCopy` writes. Copies written before this change carry no GSI1 keys and are not listed. **No backfill is needed:** nothing is deployed yet, so no such copies exist. If a deployment ever predates this change, re-put each `DISPATCH_ALERT_COPY` row with `gsi1pk = DEPT#{deptId}` and `gsi1sk = DISPATCH#{dispatchedAt}`.
