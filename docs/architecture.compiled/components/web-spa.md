# web-spa

## Purpose & Boundaries
Single responsive React SPA serving officer/chief/training/apparatus/admin desk workflows - dashboards (F8), config (F9), NERIS report authoring/review (F7), back-office data entry (F5/F6), live alert roster (F1.7) and tone-ladder controls (F1.14). Not a native surface - no offline requirement, no critical-alert entitlement. Lives at `apps/web` in the `boxalarm-ui` repo. No MFE shell/remote split (single team, single release train, hard budget constraint) - deliberately not designed as independently-deployed remotes.

## Interfaces
15 routes, base app shell with role-filtered `PrimaryNav`:

| Route | Access |
|---|---|
| `/login` | public - Cognito hosted flow, no MFA challenge |
| `/` (dashboard) | chief, officer |
| `/alerts/roster` | officer, chief - live roster + tone-ladder panel (current tone, predicate gaps, next-fire countdown, per-member lastAnsweredTone, Advance/Halt controls, amendment F1.14) |
| `/alerts/diagnostics` | officer, chief, admin - N8.3 self-diagnosis |
| `/incidents`, `/incidents/:id` | officer, chief |
| `/personnel`, `/personnel/:id` | officer, training, admin, chief |
| `/certifications` | training, admin |
| `/apparatus`, `/apparatus/:id` | apparatus, chief |
| `/schedule` | officer, admin |
| `/reporting` | chief, admin, training |
| `/settings` | admin |
| `/audit-log` | admin, chief |

Route-level code splitting (`React.lazy`) on every route per N4.1 (<2s interactive on cellular).

## Data Ownership
None (client). TanStack Query in-memory cache, no offline persistence requirement (office connectivity assumed).

## Events Produced
None directly - consumes backend REST APIs across all 10 services via `@boxalarm/core`'s generated API client.

## Events Consumed
None directly (no client-side eventing).

## Dependencies
- Internal: `@boxalarm/core` (domain types, API client, NERIS enum validation), `@boxalarm/design-tokens`, `@boxalarm/i18n` (shared packages, same `boxalarm-ui` workspace). Backend: `alerting-service`, `platform-service` (Cognito/Verified Permissions), and all other 8 backend services via their REST surfaces.
- External: `oidc-client-ts` (Cognito OIDC, Authorization Code + PKCE, `automaticSilentRenew` on, no idle-timeout logout), CloudWatch RUM (loaded once at app root, web-only per house standard).

## Gotchas & Constraints
- No login prompt, MFA challenge, or step-up re-authentication anywhere on this surface (Cross-Cutting - Session and re-authentication policy) - a re-authentication prompt appearing on any screen is a documented test failure, not a hardening improvement.
- `POST /platform/export` and destructive admin actions succeed on a valid admin session with no challenge; must be asserted 403 for non-admin roles (Cedar-gated alone) and to raise their invocation alarm.
- Full keyboard operability required on this console (N7); WCAG 2.1 AA via two contrast-qualified palettes (daylight-legible, dark-cab) beyond ordinary light/dark, both independently AA-checked.
- Selector priority for E2E tests: `getByRole()` > `getByLabel()` > `getByText()` > `getByTestId()` last resort - no CSS/XPath/id selectors.
- `@axe-core/playwright` in the same Playwright spec files driving each critical flow, not a separate a11y-only job; critical/serious violations fail the build.

## Source Sections
- Frontend section 1 Topology rationale (no MFE), lines 1747-1751
- Frontend section 2 Application topology, lines 1755-1813
- Frontend section 4.1 Web SPA component hierarchy, lines 1826-1850
- Frontend section 6 Shared dependency list, lines 1900-1924
- Frontend section 7.1 Web SPA routes, lines 1926-1948
- Frontend section 8 Accessibility, lines 1956-1966
- Testing section 3 Playwright E2E Test Plan (full section), lines 2216-2298
- Cross-Cutting - Session and re-authentication policy, lines 2500-2501
