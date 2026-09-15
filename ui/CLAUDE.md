# boxalarm-ui — session handoff

Client surfaces for **Boxalarm**, a fire department operations platform replacing Chief360. Tenant zero: Nichols FD, Trumbull CT.

**Build only — no Pulumi in this repo.** All AWS lives in `boxalarm-infrastructure`.
Product context, architecture, and the backlog live in [`boxalarm-docs`](https://github.com/zdemanche/boxalarm-docs) — read `docs/architecture.md` there before implementing anything.

## Where things stand (2026-09-03)

**Nothing is scaffolded yet.** The repo holds a README and bootstrap issue [#1](https://github.com/zdemanche/boxalarm-ui/issues/1). Architecture v1.0 and a 90-story backlog are done in `boxalarm-docs`; the user has asked for a **decision gate before the build phase begins**, so do not start generating screens until they say go.

Work is tracked as `<KEY>-UI` issues here, each a sub-issue of its story in `boxalarm-backend`. Epics and open questions stay in `boxalarm-docs`.

## Surfaces

| Surface | Stack | Scope |
|---|---|---|
| Mobile | React Native, iOS + Android, one codebase | 5 stacks, 15 screens |
| Web | React SPA | 15 routes — officer, chief, training, apparatus, admin |

**No micro-frontend topology.** One application per surface, deliberately — the Moonaan MFE shell/remote pattern buys nothing at single-department scale. Do not apply `sdlc:mfe-architecture` here. Revisit only when a second department needs an independent deploy cadence.

Shared packages: `@boxalarm/core` (owns the offline sync engine) · `@boxalarm/design-tokens` · `@boxalarm/i18n`. The bootstrap issue predates the rebrand and says `@fd/*` — use `@boxalarm/*`.

## Why native, not a PWA — settled, do not relitigate

Alert delivery is life-safety critical: the app **replaces radio tone-out as the alerting path of record**. iOS Critical Alerts and Android full-screen intent are unavailable to a PWA, so N1 reliability cannot be met without native. The notification extensions are small hand-written Swift/Kotlin modules; everything else is shared RN.

**Alert receipt must not depend on the app being foregrounded, recently opened, or exempt from battery optimization.**

Blocked on the Apple Critical Alerts entitlement — [boxalarm-docs#3](https://github.com/zdemanche/boxalarm-docs/issues/3). It can be rejected; that is a known risk with no workaround inside this repo.

## Design center

**A volunteer on a phone, at night, in a hurry** — often in turnout gear with gloves, sometimes in a moving apparatus. Any workflow that assumes a desk is wrong by default.

- Truck check completable in **under 90 seconds**
- Offline capture with sync-on-reconnect (the sync engine lives in `@boxalarm/core`)
- WCAG 2.1 AA, glove-sized touch targets, dual contrast palettes for daylight *and* a dark apparatus cab

Auth: `react-native-app-auth` (mobile), `oidc-client-ts` (web) against Cognito.

## How to work here

- **Trace cross-domain seams end to end as a chain, not edit-by-edit.** Every defect in this project so far lived *between* domains, never inside one.
- Route codegen/architecture/review through the `sdlc:*` agents — don't hand-write it.
- Accessibility is not a later pass — it is a design constraint driven by gloves and darkness.
- Tracker is GitHub Issues, not Jira. `/sdlc:generate-code` targets Jira's REST API, so its output has to be converted to `gh issue` calls.
- Prefer Read/Grep/Glob/Edit/Write over `cat`/`sed`/`grep`.
