# MOBILE-UI: Mobile app gaps: real date/time pickers, fresh profile after save, inline out-of-service from a defect, transcript PDF, and 'why didn't I get the page' diagnostics

**Key:** MOBILE-UI
**Story:** E2-S5-UI, E2-S6-UI, E4-S4-UI, E3-S7-UI, E1-S12-UI (mobile halves)
**Directory:** `ui/`
**Issues:** #143, #144, #122, #153, #160

Concrete gaps found in triage on main: #143 `AvailabilityScreen.tsx` uses plain `TextInput` for date/time (a `ponytail:` shortcut) — replace with real native date-time pickers; #144 `MeHomeScreen` fetches the profile only on mount, so returning from a successful `ProfileEditScreen` save shows stale data — refresh on focus; #122 `DefectReportScreen` shows only a warning for OUT_OF_SERVICE severity — offer the apparatus out-of-service transition inline (AC5) using the existing service-status API; #153 mobile `TranscriptScreen` only shares CSV — add the PDF export the backend already serves (`format=pdf`); #160 mobile `DiagnosticsScreen` says 'not yet connected' — wire it to the alerting diagnostics API that already exists in `backend/src/services/alerting-service` (read the handler for its route and shape). #153 and #160 also have web halves owned by another run — use `Refs #153` and `Refs #160`.

## Decision (answers the prior run's STOP on #160 AC1/AC2/AC4/AC5)

The architecture doc omits it, but a **member self-service diagnostics route already exists on main**: `GET /api/v1/alerting/dispatches/{dispatchId}/diagnostics` — `backend/src/services/alerting-service/diagnostics/selfHandler.ts`, deployed in `infrastructure/components/alerting/routes-ops.ts` (`diagnosticsSelf`), Cedar action `ViewOwnDiagnostics`, memberId derived server-side from the verified token. It returns `{ dispatchId, diagnosis: 'ON_ROSTER' | 'NOT_ON_ELIGIBLE_ROSTER', timeline, deviceState }`. That satisfies AC4 ("own timeline without admin access"). Build the mobile diagnostics screen on it.

**Decision on dispatch selection:** there is no member-readable "list recent dispatches" route, and one is out of scope for this ui-only run. The screen gets two entry points: (1) a "Didn't get this page? Diagnose" action on `AlertDetailScreen` that opens diagnostics for that dispatchId, and (2) on `DiagnosticsScreen`, a field to enter a dispatch ID when the member never received the alert. A recent-dispatch picker is deferred to a follow-up backend+infra story — mention it in the PR body and use `Refs #160` (not Closes). Do not stop on this again.

## Standing notes (apply to every issue below)

- **Monorepo.** Repo root is `/Users/zacharydemanche/Projects/boxalarm`. This run touches **only `ui/`** (plus tests inside it). Sibling bundle runs own the other directories and run concurrently; do not edit them.
- **The issues' "Current state" sections are stale** — written before ~30 batch PRs merged. Verify everything against `main`; reuse what exists, never duplicate it.
- **Wording constraint for the plan document.** A mechanical plan gate greps for the literal string `caller-supplied` (and `caller supplies`) and fails the plan on a match, even inside a sentence that denies it. Never use those phrases. Say "derived server-side from the verified token" / "originates from the authenticated principal" instead.
- **Alerting invariants** (life-safety): alerting plane is SNS FIFO; routing and dedup key on `channel` (never `channelTier`); exactly-once key `{dispatchId}#{toneSequence}#{memberId}#{channel}`; alerting isolation is an IAM boundary; `{deptId}` is in every partition key.
- Auth is settled: no MFA, no step-up, no session timeout.
- One PR closes the issues listed below as `Closes #n`, except where a note says an issue is only partly delivered — use `Refs #n` for those.
- **This run touches only `ui/apps/mobile/`** — a concurrent run owns `ui/apps/web/`. Do not edit web.
- **The UI must be top-tier — best-in-class, visibly better than Chief360.** Follow `docs/design.md` ("Command console" direction) and `docs/a11y-spec.md`; build from the existing mobile components and design tokens (`ui/packages/design-tokens`). Glove-friendly touch targets, legible in sunlight, VoiceOver/TalkBack complete, status never by colour alone. Life-safety beats pretty: nothing here may block or slow the alert path.
- Adding a well-chosen, maintained RN dependency is fine where the platform needs one (e.g. `@react-native-community/datetimepicker` for #143).
- Jest + React Native Testing Library tests in the style of existing `*.test.tsx` screens. Fixtures use Nichols FD apparatus: Rescue 300, Engine 301, Truck 304, Engine 305, Squad 309.


---

# Issues in this bundle

## #143 — E2-S5-UI: Planned unavailability (marking off) that suppresses alerting

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/46 · **Wave:** 4

The mobile app delivers the mark-off screen members use to suppress their own alerting.

## Scope
Surface: mobile.
- Wire `screens/schedule/AvailabilityScreen.tsx` to `POST /api/v1/personnel/members/{memberId}/availability` (replace `mockScheduleRepository.markUnavailable`).
- Replace the fixed `defaultStart()`/`defaultEnd()` with real start/end date-time pickers; reason field stays.
- States: submitting, success (announced), validation error (endAt ≤ startAt), offline (queued, shown pending — never shown as active until the server confirms).

## Acceptance criteria
1. Given a member selects a window and reason, when they submit, then the API is called with that `startAt`/`endAt`/`reason` and success is announced (AC1).
2. Given the server rejects the window, when the response returns, then an accessible error is shown and no "marked off" confirmation appears.
3. Given the app is offline, when the member submits, then the mark-off shows as pending, not in effect.

## Current state
Mobile screens at origin/main are design-system phase output wired to mock repositories (`apps/mobile/src/features/*/mock*Repository.ts`), not real APIs; `apps/mobile/src/lib/apiClient.ts` exists but no feature uses it. `AvailabilityScreen.tsx` exists (ScheduleStack `Availability`) with a reason field and hard-coded window.

## Depends on
- E2-S5-INFRA




---

## #144 — E2-S6-UI: Member self-service profile and contact update

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/47 · **Wave:** 4

The mobile app delivers the profile view and edit screen members use to update their own contact details.

## Scope
Surface: mobile.
- Wire `MeHomeScreen` profile to `GET /api/v1/personnel/members/{memberId}` (replace `mockMeRepository.getProfile`).
- New `ProfileEdit` screen in MeStack: phone, email, first name, last name (matches backend `UPDATABLE_FIELDS`) → `PUT /members/{memberId}`; validation, saving, success, and error states.

## Acceptance criteria
1. Given a member edits phone and email, when they save, then the API is called and Me shows the new values (AC1).
2. Given a 403 (not expected on own record), when it returns, then an accessible error renders (AC2).
3. Given VoiceOver/TalkBack, when navigating the edit screen, then every field has a label, errors are announced, and targets are ≥ 44pt/48dp (AC4, N7.2).

## Current state
Mobile screens at origin/main are design-system phase output wired to mock repositories (`apps/mobile/src/features/*/mock*Repository.ts`), not real APIs; `apps/mobile/src/lib/apiClient.ts` exists but no feature uses it. `MeHomeScreen.tsx` renders a read-only mock profile; no edit screen exists.

## Depends on
- E2-S6-INFRA




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

