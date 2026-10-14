# boxalarm-ui

Client surfaces for **[Boxalarm](../README.md)** — a fire department operations platform. Tenant zero: Nichols Fire Department, Trumbull CT.

**Live demo:** <https://zdemanche.github.io/Boxalarm/> — the web app built with sample data and no sign-in. The blue bar's **Viewing as** switcher changes role (Chief, Officer, Admin, Training, Apparatus, Member) without reloading.

**Build only — no infrastructure code lives here.** All Pulumi is in [`../infrastructure`](../infrastructure).

## Surfaces

| Surface | Stack | Notes |
|---|---|---|
| Mobile | React Native (`apps/mobile`, iOS + Android, one codebase) | 5 stacks, 15 screens |
| Web | React SPA (`apps/web`) | ~30 routes across Overview, Response, People, Apparatus, Prevention and Admin; role-gated nav |

**No micro-frontend topology.** One application per surface, deliberately — the Moonaan MFE shell/remote pattern buys nothing at a single-department scale. Revisit when a second department needs an independent deploy cadence.

## Shared packages

Only `@boxalarm/design-tokens` is built. `@boxalarm/core` and `@boxalarm/i18n` are planned but do not exist; the offline sync engine lives in `apps/mobile/src/sync`.

## Why native, not a PWA

Alert delivery is life-safety critical — the app replaces radio tone-out as the alerting path of record. iOS Critical Alerts and Android full-screen intent are unavailable to a PWA, so N1 reliability cannot be met without native. The notification extensions are small hand-written Swift/Kotlin modules; everything else is shared RN.

Alert receipt must not depend on the app being foregrounded, recently opened, or exempt from battery optimization.

## Design center

**A volunteer on a phone, at night, in a hurry** — often in turnout gear with gloves, sometimes in a moving apparatus. Any workflow that assumes a desk is wrong by default.

- Truck check completable in **under 90 seconds**
- Offline capture with sync-on-reconnect
- WCAG 2.1 AA, glove-sized touch targets, dual contrast palettes for daylight *and* a dark apparatus cab

## Getting started

```bash
cd ui
npm ci
VITE_DEMO=true npm run dev --workspace apps/web   # web app with sample data, no Cognito needed
npm run typecheck && npm run lint && npm run format && npm test
npm run test:e2e                                 # Playwright against a production build
```

**iPhone app in the iOS Simulator (demo, no sign-in):** in `apps/mobile`, create a `.env` with
`DEMO_MODE=true` and no `API_BASE_URL` (every screen then serves its mock data as a signed-in demo
officer), put a `GoogleService-Info.plist` in `ios/Boxalarm/` (a placeholder works; push does
nothing in the demo), then:

```bash
cd apps/mobile/ios && pod install && cd ..
npx react-native start                      # Metro, in its own terminal
npx react-native run-ios --simulator "iPhone 17 Pro"
```

DEMO_MODE is refused whenever `API_BASE_URL` is set, so a demo session never reaches a real API.

Without `VITE_DEMO`, the web app needs `COGNITO_ISSUER`, `COGNITO_WEB_CLIENT_ID` and
`COGNITO_HOSTED_UI_ORIGIN` (see `apps/web/src/auth/config.ts`). The GitHub Pages demo is built and deployed by the `pages-build` and
`pages-deploy` jobs in `.github/workflows/ui.yml` on every push to `main`, after `ui-verify` passes.

Demo data lives in `apps/web/src/lib/demoRoster.ts` (the shared roster and fleet) and the
per-feature `demoFixtures.ts` files; it is deterministic and dated relative to today.
