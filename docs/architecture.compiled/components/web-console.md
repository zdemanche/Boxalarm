# Web Console

## Purpose & Boundaries
Single responsive React SPA (`apps/web`) serving officer/chief/training/apparatus/admin desk workflows: dashboards (F8), department config (F9), NERIS report authoring/review, F5/F6 back-office entry, alerts roster/diagnostics. No PWA; mobile is native only. No MFE.

## Interfaces
15 routes (React.lazy route-level splitting, N4.1 <2s on cellular): `/login` (public Cognito hosted flow, self-service recovery; no MFA), `/` dashboard (chief, officer), `/alerts/roster` (officer, chief; tone-ladder panel with Advance/Halt), `/alerts/diagnostics` (officer, chief, admin), `/incidents`, `/incidents/:id` (officer, chief), `/personnel`, `/personnel/:id`, `/certifications` (training, admin), `/apparatus`, `/apparatus/:id`, `/schedule` (officer, admin), `/reporting` (chief, admin, training), `/settings` (admin), `/audit-log` (admin, chief). Component tree: AuthProvider (oidc-client-ts), ThemeProvider (light/dark/high-contrast cab mode), QueryClientProvider, AppShell (SkipToContentLink, role-filtered PrimaryNav, LiveRegion), features/{alerting, incident-reporting, personnel, apparatus, training, scheduling, reporting}, pieces/, components/.

## Data Ownership
No persistent data; TanStack Query in-memory cache (no offline requirement). Refresh token stored in `localStorage` (CSP specified but deferred, `docs/decisions/2026-09-29-web-csp.md`).

## Events Produced
absent — the source document does not address this.

## Events Consumed
absent — the source document does not address this.

## Dependencies
internal: ui-shared-packages, all backend services via API (alerting, platform, incident, reporting), infrastructure (hosting). external: Cognito, CloudWatch RUM (web only, loaded once at app root), Storybook/axe.

## Gotchas & Constraints
- `oidc-client-ts` `automaticSilentRenew` on; no idle-timeout logout; no step-up prompt anywhere (a re-auth prompt is a test failure).
- Single `<h1>` per page; skip link; keyboard-only operable NERIS wizard, no traps; aria-live polite for sync/submission results.
- UI components not shared with RN; tokens shared as raw values.
- Incident authoring is primarily web; native limited to view/status.
- Daylight palette and dark-cab palette independently AA-checked.
- `@axe-core/playwright` fails build on critical/serious.
- CloudFront is ruled out (N6.1) — hosting must respect that.

## Source Sections
Frontend §1-2 (1962-2028); §3 repo (2030-2037); §4.1 (2041-2065); §6 deps (2115-2139); §7.1 routes (2143-2163); §8 a11y (2171-2181); assumptions (2202-2205)
