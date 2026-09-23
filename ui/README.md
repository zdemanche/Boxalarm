# boxalarm-ui

Client surfaces for **[Boxalarm](https://github.com/zdemanche/boxalarm-docs)** — a fire department operations platform. Tenant zero: Nichols Fire Department, Trumbull CT.

**Build only — no infrastructure code lives here.** All Pulumi is in [`boxalarm-infrastructure`](https://github.com/zdemanche/boxalarm-infrastructure).

## Surfaces

| Surface | Stack | Notes |
|---|---|---|
| Mobile | React Native (iOS + Android, one codebase) | 5 stacks, 15 screens |
| Web | React SPA | 15 routes — officer, chief, training, apparatus, admin |

**No micro-frontend topology.** One application per surface, deliberately — the Moonaan MFE shell/remote pattern buys nothing at a single-department scale. Revisit when a second department needs an independent deploy cadence.

## Shared packages

`@boxalarm/core` (owns the offline sync engine) · `@boxalarm/design-tokens` · `@boxalarm/i18n`

## Why native, not a PWA

Alert delivery is life-safety critical — the app replaces radio tone-out as the alerting path of record. iOS Critical Alerts and Android full-screen intent are unavailable to a PWA, so N1 reliability cannot be met without native. The notification extensions are small hand-written Swift/Kotlin modules; everything else is shared RN.

Alert receipt must not depend on the app being foregrounded, recently opened, or exempt from battery optimization.

## Design center

**A volunteer on a phone, at night, in a hurry** — often in turnout gear with gloves, sometimes in a moving apparatus. Any workflow that assumes a desk is wrong by default.

- Truck check completable in **under 90 seconds**
- Offline capture with sync-on-reconnect
- WCAG 2.1 AA, glove-sized touch targets, dual contrast palettes for daylight *and* a dark apparatus cab

## Getting started

Not yet scaffolded — see [#1](https://github.com/zdemanche/boxalarm-ui/issues/1).
