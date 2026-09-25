# WEB-UI: Web: alert diagnostics + canary health, transcript a11y, maintenance scheduling, training-events e2e, MapProvider port, defect photos

**Key:** WEB-UI
**Story:** E1-S12/E1-S10/E3-S7/E4-S6/E3-S4/E5-S6/E4-S4 web halves
**Directory:** `ui/`
**Issues:** #160, #159, #153, #124, #152, #137, #122

Concrete gaps on main:
- **#160 / #159** — `/alerts/diagnostics` is a placeholder. Build the 'why didn't I get the page' self-diagnosis view (per-member delivery timeline + eligibility reasons) and the canary health panel, against the alerting diagnostics and canary-status APIs already in `backend/src/services/alerting-service` (a concurrent run does the mobile half of #160, so `Closes #159`, `Refs #160`).
- **#153** — web transcript export exists; add the axe scan targeting the transcript view (AC4). `Refs #153` (mobile PDF is another run).
- **#124** — maintenance log form has no `scheduledNextAt` input and there's no due-soon panel on `/apparatus` (AC3). Add both if the backend handlers accept/serve them; otherwise note the residual.
- **#152** — add the Playwright create → sign-up → mark-attended spec for training events.
- **#137** — `MapPage.tsx` imports `leaflet`/`react-leaflet` directly, bypassing the `MapProvider` port the ticket requires (OQ-20 vendor undecided). Route all map rendering through the `MapProvider` interface in `mapProvider.tsx`, with the Leaflet renderer as one implementation behind it.
- **#122** — web open-defects list shows no photo; render defect photos via the signed URL the backend returns. (Mobile half of #122 is another run — `Refs #122`.)

## Standing notes (apply to every issue below)

- **Monorepo.** Repo root is `/Users/zacharydemanche/Projects/boxalarm`. This run touches **only `ui/`** (plus tests inside it). Other bundle runs edit other areas concurrently; do not touch them.
- **The issues' "Current state" sections are stale** — written before ~30 batch PRs merged. Verify everything against `main`; reuse what exists, never duplicate it.
- **Wording constraint for the plan document.** A mechanical plan gate greps for the literal string `caller-supplied` (and `caller supplies`) and fails the plan on a match, even inside a sentence that denies it. Never use those phrases. Say "derived server-side from the verified token" / "originates from the authenticated principal" instead.
- **Alerting invariants** (life-safety): alerting plane is SNS FIFO; routing and dedup key on `channel` (never `channelTier`); exactly-once key `{dispatchId}#{toneSequence}#{memberId}#{channel}`; alerting isolation is an **IAM boundary** — no LOB role gains any alerting-table permission, alerting Lambdas stay out of any VPC; `{deptId}` is in every partition key.
- Auth is settled: no MFA, no step-up, no session timeout.
- One PR closes the issues below as `Closes #n`; use `Refs #n` for any issue a note says is only partly delivered.
- **This run touches only `ui/apps/web/`**, and a concurrent run is building `ui/apps/web/src/features/incidents/`. Don't touch incidents; keep route-table/App.tsx edits minimal (one entry per new route) so merges are trivial.
- **The UI must be top-tier — best-in-class, visibly better than Chief360.** Follow `docs/design.md` ("Command console" direction) and `docs/a11y-spec.md` exactly; build from the existing design system and shared components. Match or raise the polish of `features/apparatus` and `features/personnel`. Legible before pretty; WCAG 2.1 AA; status never by colour alone.
- Use real API calls through the existing `apiClient` pattern against routes on main (read the backend handler for each shape).
- Tests: Vitest + Testing Library/MSW, plus Playwright specs with axe scans under `ui/apps/web/tests/e2e/`. Fixtures use Nichols FD apparatus: Rescue 300, Engine 301, Truck 304, Engine 305, Squad 309.


---

# Issues in this bundle

## #160 — E1-S12-UI: 'Why didn't I get the page' self-diagnosis tool

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/37 · **Wave:** 8

The web diagnostics console and the member-facing native version.

## Scope
- **Web** `/alerts/diagnostics` (officer, chief, admin):
  - pick member + dispatch, then render a timeline from `GET /api/v1/alerting/audit`: dispatch received → push sent → delivered → opened → response logged, per channel and tone
  - device-check panel
  - explicit 'not on the eligible roster' diagnosis when no delivery record exists
- **Mobile** `DiagnosticsScreen` (Me tab): the member's own recent dispatches and timeline, plus a device-check card.
- **Mobile device self-report:** notification permission, critical-alert / full-screen-intent permission, battery-optimization exemption, app and OS version. Sent with push-token registration (`POST /api/v1/personnel/members/{memberId}/push-tokens`) so admins see last-known state.

## Acceptance criteria
- Given an admin selects a member and dispatch, when the page loads, then the audit timeline renders (parent AC1).
- Given device state was reported, when viewed, then all four device checks show with the time they were reported (parent AC2).
- Given no delivery record, when rendered, then the tool states the member was not on the eligible roster, distinct from 'sent, not delivered' (parent AC5).
- Given a member on mobile, when they open Diagnostics, then they see their own timeline and device checks without admin access (parent AC4).
- Given the dense timeline table, when axe runs, then there are no critical/serious violations. VoiceOver/TalkBack passes on the native version (parent test notes).

## Current state
- `apps/mobile/src/screens/me/DiagnosticsScreen.tsx` is a static placeholder ('not yet connected').
- Web has no route.
- The backend register-token body today accepts only `{platform, token}`; extending it for device state is backend work under this parent.

## Depends on
- E1-S9-INFRA
- E1-S14-UI (token registration path)
- E1-S7 (ui#26: reading critical-alert / full-screen-intent permission state)



---

## #159 — E1-S10-UI: Continuous production canary with on-call escalation

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/35 · **Wave:** 8

The admin-visible canary health indicator that feeds N8.3.

## Scope
- **Web:** canary health panel on `/alerts/diagnostics` (admin, chief, officer) from `GET /api/v1/alerting/canary/status`: last run time, result, per-channel outcome, latency against the 5s budget.

## Acceptance criteria
- Given the status endpoint, when the diagnostics page loads, then the last canary run, per-channel outcome and latency show (parent AC5).
- Given the last run is older than two schedule intervals, when rendered, then it shows as unhealthy, never as a stale green (parent AC2 intent).
- Given state is conveyed, when inspected, then it uses text as well as colour (N7.1).

## Current state
`apps/web` has no `/alerts/diagnostics` route.

## Depends on
- E1-S10-INFRA
- E1-S12-UI (route)



---

## #153 — E3-S7-UI: Exportable per-member training transcript

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/59 · **Wave:** 6

The web SPA and mobile app deliver the transcript view and CSV/PDF export.

## Scope
Surfaces: web + mobile.
- Web `/personnel/:id` transcript tab (training officer): certifications with status, attendance history, category-hour totals; "Export CSV" / "Export PDF" download.
- Mobile MeStack `Transcript` screen: same content for the member, export via the native share sheet.

## Acceptance criteria
1. Given a member with history, when the transcript opens, then certs, attendance, and hour totals render (AC1).
2. Given CSV or PDF is chosen, when export completes, then the file downloads (web) or opens the share sheet (mobile) (AC2).
3. Given no history, when opened, then an empty but well-formed transcript renders (AC3).
4. Given axe on the web transcript view, when scanned, then no critical/serious violations (test notes, F3.6).

## Current state
`apps/web` at origin/main has only sign-in, auth callback, and a landing page (`apps/web/src/App.tsx`); none of the §7.1 routes exist. `apps/web/src/lib/apiClient.ts` exists. Mobile screens at origin/main are design-system phase output wired to mock repositories (`apps/mobile/src/features/*/mock*Repository.ts`), not real APIs; `apps/mobile/src/lib/apiClient.ts` exists but no feature uses it.

## Depends on
- E3-S7-INFRA
- E2-S1-UI, E3-S1-UI




---

## #124 — E4-S6-UI: Maintenance history and scheduled maintenance

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/66 · **Wave:** 4

Maintenance tab on web apparatus detail plus the due-soon listing.

## Scope
- Web `/apparatus/:id` Maintenance tab: log form (description, vendor, cost, optional scheduledNextAt) -> POST `/api/v1/apparatus/{unitId}/maintenance`; history + next scheduled from GET.
- Web `/apparatus` due-soon panel: maintenance entries alongside SCBA/testing items as those land (E4-S7/E4-S8).

## Acceptance criteria
- Given a completed event, when logged, then it appears in history with vendor and cost (AC1).
- Given history, when the tab loads, then past records and the next scheduled item render sorted by date (AC2).
- Given a scheduledNextAt inside the reminder window, when the due-soon panel loads, then it is listed (AC3).

## Current state
- `boxalarm-ui` origin/main: web SPA has only `/` (landing/sign-in) and `/auth/callback`; `apps/web/src/lib/apiClient.ts` exists but no domain screens. Mobile Checks stack (`ApparatusPickerScreen`, `CheckRunnerScreen`, `DefectReportScreen`) reads `features/checks/mockChecksRepository.ts` - no real API calls; `apps/mobile/src/lib/apiClient.ts` is unused by features.

## Depends on
- E4-S6-INFRA
- E4-S1-UI




---

## #152 — E3-S4-UI: Drill and training event scheduling with member sign-up

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/56 · **Wave:** 4

The web SPA delivers training-event scheduling and attendance entry; the mobile app delivers member browsing and sign-up.

## Scope
Surfaces: web + mobile.
- Web (training feature): create event (title, category, startAt, endAt); per-event attendee list with hours entry after the event; event list with sign-up (Playwright create → sign-up → mark-attended flow).
- Mobile (ScheduleStack): training events list from `GET /training/events` with sign-up → `POST .../signup`; signed-up events visually and textually distinguished.

## Acceptance criteria
1. Given a training officer creates an event, when the list loads, then it appears in start order (AC1).
2. Given a member signs up, when the list reloads, then the event is marked signed up (AC2, AC4).
3. Given an event has passed, when the officer records hours, then attendees show those hours (AC3).

## Current state
`apps/web` at origin/main has only sign-in, auth callback, and a landing page (`apps/web/src/App.tsx`); none of the §7.1 routes exist. `apps/web/src/lib/apiClient.ts` exists. Mobile screens at origin/main are design-system phase output wired to mock repositories (`apps/mobile/src/features/*/mock*Repository.ts`), not real APIs; `apps/mobile/src/lib/apiClient.ts` exists but no feature uses it.

## Depends on
- E3-S4-INFRA
- E2-S1-UI (app shell/nav)




---

## #137 — E5-S6-UI: Map-based retrieval of occupancies and hydrants

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/80 · **Wave:** 4

Web map screen built on a MapProvider port with a stub renderer and a list alternative.

## Scope
- Web `/inspections/map`: `MapProvider` interface + stub renderer (OQ-20 unresolved, no vendor SDK); GET `/api/v1/inspections/map?bbox=` on viewport change; merge by entity id.
- Keyboard pan/zoom controls and a list view alternative; OOS hydrants distinct by label/icon.

## Acceptance criteria
- Given a viewport, when rendered, then occupancies and hydrants from the API show via the port with no vendor import (AC1, AC2).
- Given an OOS hydrant in view, when rendered, then it is distinguished in map and list (AC3).
- Given pan across cell boundaries, when results merge, then no duplicate markers (AC4).
- Given keyboard-only use, when navigating, then pan/zoom and the list view work and axe passes.

## Current state
- `boxalarm-ui` origin/main: web SPA has only `/` (landing/sign-in) and `/auth/callback`; `apps/web/src/lib/apiClient.ts` exists but no domain screens. Mobile Checks stack (`ApparatusPickerScreen`, `CheckRunnerScreen`, `DefectReportScreen`) reads `features/checks/mockChecksRepository.ts` - no real API calls; `apps/mobile/src/lib/apiClient.ts` is unused by features.

## Depends on
- E5-S6-INFRA
- E5-S3-UI




---

## #122 — E4-S4-UI: Report a defect with photo, routed to the apparatus officer

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/64 · **Wave:** 7

Defect report with photo capture, offline queue, and OOS hand-off; officer's open-defects view on web.

## Scope
- Mobile `DefectReportScreen`: photo capture (replace "Photo attachment is not yet connected"), queue report + photo in the outbox; on drain upload photo via signed URL then POST `/api/v1/apparatus/{unitId}/defects` with `photoS3Key`.
- Severity OUT_OF_SERVICE: offer the E4-S5 service-status transition in the same flow, prefilled apparatus (officer/admin only).
- Web `/apparatus/:id`: open defects list (description, severity, photo via signed URL).

## Acceptance criteria
- Given a defect with photo, when submitted online, then the report and photo upload and status shows OPEN (AC1).
- Given no connectivity, when submitted, then report and photo queue locally and upload on reconnect (AC4).
- Given severity OUT_OF_SERVICE, when submitted by an officer, then the OOS transition is available without re-entering the unit (AC5).
- Given a failed photo upload, when it fails, then the sync UI shows that item with retry (N3.4).

## Current state
- `boxalarm-ui` origin/main: web SPA has only `/` (landing/sign-in) and `/auth/callback`; `apps/web/src/lib/apiClient.ts` exists but no domain screens. Mobile Checks stack (`ApparatusPickerScreen`, `CheckRunnerScreen`, `DefectReportScreen`) reads `features/checks/mockChecksRepository.ts` - no real API calls; `apps/mobile/src/lib/apiClient.ts` is unused by features.

## Depends on
- E4-S3-UI (sync engine)
- E4-S5-UI
- E4-S4-INFRA




---

