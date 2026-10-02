# Web SPA

## Purpose & Boundaries
Single React SPA (`apps/web`) for officer/chief/training/apparatus/admin desk workflows: F8 dashboards, F9 config, NERIS report authoring/review, F5/F6 back-office entry, live roster with tone-ladder panel, diagnostics. No PWA, no MFE, no separate admin/member apps. Incident authoring primarily web; native views/status only. Not offline-capable.

## Interfaces
Routes (15, all lazy-split): `/login` (public; no MFA), `/` dashboard (chief, officer), `/alerts/roster` (tone-ladder panel: current tone, predicate gaps, countdown, `lastAnsweredTone`, officer-gated Advance/Halt), `/alerts/diagnostics` (officer, chief, admin), `/incidents`, `/incidents/:id`, `/personnel`, `/personnel/:id`, `/certifications` (training, admin), `/apparatus`, `/apparatus/:id`, `/schedule` (officer, admin), `/reporting` (chief, admin, training), `/settings` (admin), `/audit-log` (admin, chief). Structure: `App > AuthProvider > ThemeProvider > QueryClientProvider > AppShell(SkipToContentLink, PrimaryNav role-filtered, LiveRegion)`; `features/{alerting,incident-reporting,personnel,apparatus,training,scheduling,reporting}`, `pieces/`, `components/`, `shared/`.

## Data Ownership
absent — the source document does not address this (client; TanStack Query in-memory cache only). Refresh token in `localStorage` (CSP deferred, `docs/decisions/2026-09-29-web-csp.md`).

## Events Produced
absent — the source document does not address this

## Events Consumed
absent — the source document does not address this

## Dependencies
internal: `@boxalarm/core`, `@boxalarm/design-tokens`, `@boxalarm/i18n` (shared; UI components NOT shared with RN), all backend services. external: Cognito via `oidc-client-ts` (Auth Code+PKCE, `automaticSilentRenew`, no idle logout), CloudWatch RUM (web only), CSS Modules, react-router-dom, jotai, i18next, Storybook+a11y, `@axe-core/playwright`.

## Gotchas & Constraints
- A re-auth prompt on any surface is a TEST FAILURE, not hardening.
- Tokens: design-tokens includes daylight palette and dark-cab palette independently AA-checked.
- WCAG 2.1 AA; single `<h1>`; keyboard operable, no wizard traps; aria-live polite for sync/submission; critical/serious axe violations fail build; manual NVDA passes per wave.
- Check Moonaan Design System before custom components; Playwright: `getByRole` > label > text > testid; POM per page.
- Repo is monorepo `ui/` (npm workspaces, no Nx/Turborepo) — historical spec said `boxalarm-ui`.

## Source Sections
Frontend §1–4.1 1958–2065; §6 deps 2115–2139; §7.1 routes 2143–2163; §8 a11y 2171–2181; Open questions 2193–2205; Testing §3–4 2443–2565.
