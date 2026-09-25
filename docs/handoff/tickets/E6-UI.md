# E6-UI: Incidents web UI: list/search, detail, create from dispatch, guided NERIS completion, narrative, response times, exposures

**Key:** E6-UI
**Story:** E6-S2/S3/S4/S5/S6/S10 UI children
**Directory:** `ui/`
**Issues:** #170, #163, #164, #165, #166, #167

`ui/apps/web` routes `/incidents` and `/incidents/:id` to a `PlaceholderPage` today — no incidents feature exists. All backend routes for these stories are on main. Build `ui/apps/web/src/features/incidents/`: a searchable/date-filtered incident list (#170), incident detail as the hub, create-incident-from-dispatch pre-filled from the alert/CAD/response roster (#163), guided multi-step NERIS completion with pre-submission enum validation that mirrors the server's `validateEnum` rules (#164 — if a shared `@boxalarm/core` package does not exist, put the validation in the feature, do not create a new package), narrative editor with live character count against the 25,000 limit (#165), per-unit response-time editor (#166), and exposure/responder-safety capture (#167). Submission to NERIS (E6-S8/S9 UI) is out of scope — its backend does not exist yet.

## Standing notes (apply to every issue below)

- **Monorepo.** Repo root is `/Users/zacharydemanche/Projects/boxalarm`. This run touches **only `ui/`** (plus tests inside it). Sibling bundle runs own the other directories; do not edit them.
- **The issues' "Current state" sections are stale** — they were written before ~30 batch PRs merged. Verify everything against the code on `main`; reuse what exists, never duplicate it.
- **Wording constraint for the plan document.** A mechanical plan gate greps for the literal string `caller-supplied` (and `caller supplies`) and fails the plan on a match, even inside a sentence that denies it. Never use those phrases. Say "derived server-side from the verified token" / "originates from the authenticated principal" instead. This changes nothing about the design.
- **Alerting invariants** (life-safety, non-negotiable): alerting plane is SNS FIFO; routing and dedup key on `channel` (never `channelTier`); exactly-once key `{dispatchId}#{toneSequence}#{memberId}#{channel}`; alerting isolation is an **IAM boundary** — no LOB role gains any alerting-table permission, and alerting Lambdas stay out of any VPC; `{deptId}` is in every partition key.
- Auth is settled: no MFA, no step-up, no session timeout. Do not add any.
- One PR closes every issue listed below; list them as `Closes #n` in the PR body.
- **The UI must be top-tier — best-in-class, visibly better than Chief360.** Functional-but-plain is a failure. Follow `docs/design.md` (the "Command console" direction) and `docs/a11y-spec.md` exactly; build from the existing design system (`ui/packages/design-tokens` and the shared components already used by `ui/apps/web/src/features/*`). Match the polish of the best existing screens (look at `features/apparatus` and `features/personnel`). Legible before pretty; WCAG 2.1 AA; keyboard + screen-reader complete; status never conveyed by colour alone.
- Use real API calls through the existing `apiClient` pattern (see other features' `api.ts`) against the backend routes that already exist on main in `backend/src/services/incident-service/`; match request/response shapes by reading the handlers.
- Tests: Vitest + Testing Library/MSW in the style of existing feature tests, plus a Playwright spec with an axe scan for the incidents flow under `ui/apps/web/tests/e2e/`. Fixtures use Nichols FD apparatus: Rescue 300, Engine 301, Truck 304, Engine 305, Squad 309.


---

# Issues in this bundle

## #170 — E6-S10-UI: Incident search and history

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/92 · **Wave:** 4

Incident list with date-range search, plus incident detail, on the web console.

## Scope
- Surface: web `/incidents` (officer, chief): date-range filter → `GET /api/v1/incidents`. Rows show incident type, address, date and submission status from the list response.
- `/incidents/:id`: `GET /api/v1/incidents/{incidentId}` renders summary fields plus the corePayload in one request.
- Route-level `React.lazy` split. No keyword or narrative search (v1 limitation).

## Acceptance criteria
1. Given incidents spanning several months, when an officer filters by date range, then only incidents in range are listed, ordered by alarm time (AC1).
2. Given an incident, when its detail opens, then the whole record loads from a single request (AC2).
3. Given search results, when rows render, then type, address, date and submission status are shown with no per-row API call (AC3).

## Current state
- `apps/web` has no feature routes yet.

## Depends on
- E6-S10-INFRA, E8-S3-UI.



---

## #163 — E6-S2-UI: Create incident pre-populated from alert, CAD, and response roster

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/84 · **Wave:** 7

Web console action that creates an incident from a dispatch and opens the pre-filled report.

## Scope
- Surface: web. `/incidents` (officer, chief): Create report from a dispatch → `POST /api/v1/incidents` with the dispatch ID → navigate to `/incidents/:id`.
- Detail shows the pre-filled address, incident type, narrative, alarm/dispatch timestamps and responding units/members as returned; no re-typing.
- RFC 7807 errors rendered from `ProblemDetails` (title/detail), focus moved to the message.

## Acceptance criteria
1. Given an officer on a dispatch with a live roster, when they create a report, then `/incidents/:id` opens with every AC1 field filled and nothing to re-enter (AC1, AC2).
2. Given the API returns a 4xx problem+json for an unknown dispatch, when the create fails, then the title/detail is shown and focus moves to it (AC3).
3. Given Playwright flow 8, when a dispatch closes and the report is created, then the pre-populated fields are asserted via `getByRole`/`getByLabel` selectors.

## Current state
- `apps/web/src/App.tsx` routes only `/` and `/auth/callback`; no incident screens, no PrimaryNav.
- `apps/web/src/lib/apiClient.ts` already attaches the bearer token and retries once after silent renew on 401.

## Depends on
- E6-S2-INFRA, E6-S10-UI (incident list/detail routes), E8-S3-UI (app shell + role-filtered nav).



---

## #164 — E6-S3-UI: Guided incident completion with pre-submission NERIS enumeration validation

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/85 · **Wave:** 5

Multi-step guided NERIS completion form on the web incident detail.

## Scope
- Surface: web `/incidents/:id` (officer, chief). A step-based form that saves via `PUT /api/v1/incidents/{incidentId}`.
- The server's enumeration validation is the source of truth: a 400 naming an invalid field and its allowed values maps onto that field, and progress is blocked.
- Final step shows VALIDATED status and enables the Submit action.
- Keyboard-only operable with focus moved to the field in error. axe scans on default, validation-error and submitted states.

## Acceptance criteria
1. Given an officer enters a value outside a NERIS field's enumeration, when they advance or save, then progress is blocked and that field plus its allowed values are shown (AC1).
2. Given all required Core fields are valid, when the officer reaches the final step, then status reads VALIDATED and Submit becomes available (AC2).
3. Given keyboard-only navigation, when an invalid-enum error appears, then focus moves to the field in error and no keyboard trap exists (AC3, WCAG 2.1 AA). Critical/serious axe violations fail the build.

## Current state
- No incident screens in `apps/web`. `@boxalarm/core` (the shared NERIS enum validation named in the web-spa fact sheet) does not exist yet.

## Depends on
- E6-S3-INFRA, E6-S10-UI, E8-S3-UI.



---

## #165 — E6-S4-UI: Incident narrative capture

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/86 · **Wave:** 4

Narrative editor on the web incident detail.

## Scope
- Surface: web `/incidents/:id`. A narrative text area saved via `PUT /api/v1/incidents/{incidentId}/narrative`, with a live character count against the NERIS maximum.
- A length-limit rejection is shown inline and the typed text is kept (no client truncation).

## Acceptance criteria
1. Given an officer saves a narrative, when the incident detail is reloaded, then the text is displayed unchanged (AC1).
2. Given a narrative over the NERIS maximum, when the officer saves, then the API's length-limit error is shown and the text is neither truncated nor lost (AC2).

## Depends on
- E6-S4-INFRA, E6-S10-UI.



---

## #166 — E6-S5-UI: Apparatus and personnel response times with unit assignment

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/87 · **Wave:** 8

Per-unit response-time editor on the web incident detail.

## Scope
- Surface: web `/incidents/:id`. One row per responding apparatus or member, with dispatchedAt / enRouteAt / arrivedAt / clearedAt and assigned position. Saved via `PUT /api/v1/incidents/{incidentId}/response-times`.
- Editing one timestamp sends only that field for that unit.

## Acceptance criteria
1. Given an incident with responding units, when an officer sets each of the four timestamps, then each saves and reloads independently (AC1).
2. Given a roster-pre-populated unit, when only arrivedAt is edited, then the unit's other timestamps and positions are unchanged after reload (AC2).
3. Given two responding units, when the editor loads, then each is a distinct row keyed by its unit ID (AC3).

## Depends on
- E6-S5-INFRA, E6-S2-UI, E6-S10-UI.



---

## #167 — E6-S6-UI: Exposure and responder-safety capture (NERIS Secondary schema)

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/88 · **Wave:** 5

Exposure and responder-safety module capture on the web incident detail.

## Scope
- Surface: web `/incidents/:id`. Add a Secondary module (EXPOSURE, responder-safety), select affected members, fill Secondary-schema fields, and mark complete. Saved via `PUT /api/v1/incidents/{incidentId}/exposures`.
- Invalid enum values block Mark complete, using the same field-error pattern as E6-S3-UI.
- Each module is listed as its own record.
- The section is shown only to viewers the API authorizes (affected member, chief, safety officer). The server enforces this.
- axe scans on the form's default and error states.

## Acceptance criteria
1. Given an officer records an exposure naming affected members, when saved, then the module appears with its type and affected members (AC1).
2. Given an invalid Secondary enum value, when Mark complete is pressed, then it is blocked and focus moves to the field in error (AC2).
3. Given exposure and responder-safety modules both exist, when the incident loads, then they render as two distinct records (AC3).
4. Given a viewer the API denies, when the incident loads, then the Secondary section is not rendered.

## Depends on
- E6-S6-INFRA, E6-S3-UI (field-error pattern), E6-S10-UI.



---

