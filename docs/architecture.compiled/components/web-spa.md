# web-spa

## Purpose & Boundaries

Single responsive React SPA serving officer/chief/training/apparatus/admin desk workflows — F8 dashboards, F9 config, NERIS report authoring/review, F5/F6 back-office data entry. **No MFE shell/remote split** (requirements §8) — one frontend team, one release cadence; the functional footprint doesn't justify Module Federation's cost. No PWA — mobile is exclusively the native app. Lives in the `boxalarm-ui` repo, `apps/web` workspace.

## Interfaces

15 routes, role-gated. Route-level code splitting (`React.lazy`) per N4.1 (<2s interactive on cellular).

| Route | Access | Notes |
|---|---|---|
| `/login` | public | Cognito hosted flow, self-service recovery (F9.1), no MFA challenge |
| `/` (dashboard) | chief, officer | F8.1 |
| `/alerts/roster` | officer, chief | F1.7 live roster; tone-ladder panel + officer-gated Advance/Halt (F1.14) |
| `/alerts/diagnostics` | officer, chief, admin | N8.3 self-diagnosis (§5.4) |
| `/incidents`, `/incidents/:id` | officer, chief | F7.9 search; F7 guided NERIS form (F7.2-F7.7) |
| `/personnel`, `/personnel/:id` | officer, training, admin, chief | F2.1 roster, member detail |
| `/certifications` | training, admin | F3.1-F3.6 |
| `/apparatus`, `/apparatus/:id` | apparatus, chief | F4.1 registry; checks/defects/OOS/maintenance/SCBA/testing (F4.2-F4.9) |
| `/schedule` | officer, admin | F2.8-F2.11 |
| `/reporting` | chief, admin, training | F8.2-F8.7 |
| `/settings` | admin | F9.3 department config |
| `/audit-log` | admin, chief | F9.4 |

Consumes: `CoreAPI` (platform-service + all LOB services), `AlertAPI` (alerting-service), `NERISAPI` (incident-service, via backend proxy — never calls NERIS directly), `AuthAPI` (Cognito).

## Data Ownership

None — pure client, TanStack Query in-memory cache only (no offline requirement on web, unlike mobile).

## Events Produced / Consumed

None directly — all state changes go through the REST API; no direct event-bus participation from the browser.

## Dependencies

**Internal:** every backend service via `CoreAPI`/`AlertAPI`/`NERISAPI`/`AuthAPI` (see architecture Frontend §2 diagram). Shared packages: `@boxalarm/core` (domain types, API client, validation), `@boxalarm/design-tokens` (CSS custom properties), `@boxalarm/i18n`.

**External:** `oidc-client-ts` (Cognito OIDC, Authorization Code + PKCE, `automaticSilentRenew` on, no idle-timeout logout), CloudWatch RUM (web-only, loaded once at app root), Moonaan Design System components.

## Gotchas & Constraints

- **No re-authentication prompt anywhere, ever** — `POST /platform/export` and destructive admin actions succeed on a valid admin session with no challenge; a re-auth prompt appearing on any surface is a **test failure**, not a hardening improvement.
- **No MFE topology** — revisit only if a second department needs an independently deployed, differently-branded surface, or if route count/team size outgrow one release train.
- **UI components are NOT shared with the native app** — DOM vs. native rendering targets differ too much; only design tokens (raw values) and domain logic (`@boxalarm/core`) are shared.
- **Accessibility (N7):** WCAG 2.1 AA target, `@axe-core/playwright` in CI failing on critical/serious violations; two contrast-qualified palettes (daylight-legible, dark-cab) beyond ordinary light/dark, both independently AA-checked.
- **Incident report authoring (F7) is primarily a web-console workflow** — native is limited to viewing/status; this can move if officers report needing to write reports from the truck (open assumption, not confirmed).
- **Storybook + a11y addon** for component development; **CSS Modules** for static styling; **jotai** for local/atomic state alongside React Context for auth/theme/sync.
- **Route auth is enforced server-side via Verified Permissions on every endpoint** — client-side role filtering (`PrimaryNav`) is UX convenience only, never the actual authorization boundary.

## Source Sections

- Frontend Architecture §1 Topology rationale — why no MFE (`:1870-1877`)
- Frontend Architecture §2 Application topology diagram (`:1878-1936`)
- Frontend Architecture §4.1 Web SPA component hierarchy (`:1949-1973`)
- Frontend Architecture §6 Shared dependency list (`:2023-2047`)
- Frontend Architecture §7.1 Web SPA routes (`:2049-2071`)
- Frontend Architecture §8 Accessibility (`:2079-2089`)
- Frontend Architecture Open questions/assumptions (`:2101-2113`)
- Cross-Cutting: Session and re-authentication policy (`:2623`)
