# Boxalarm mobile UI design — 10-phase build-out

Status: approved by user 2026-09-13. Source of truth for requirements: `boxalarm-docs/docs/architecture.md`
("Frontend Architecture" §§7–9, line ranges cited inline below refer to that document as of 2026-09-13).

## Why

The mobile app currently has one screen (sign-in) styled from a two-color, five-spacing-value token
stub (`packages/design-tokens/src/index.ts`). The user's complaint ("the UI for the iPhone sucks") is
accurate: there is no typography scale, no semantic color system, no icon set, and no navigation beyond
a single screen. Architecture.md is precise about *behavior and structure* (screen list, offline rules,
accessibility mechanics, touch-target minimums) but silent on *visual identity* (no hex values, no
typography, no iconography named anywhere in the document). This spec fills that gap with stated,
justified defaults and sequences the remaining build-out against two live constraints: no backend/infra
repo access yet (blocks anything needing real dispatch/roster/API data), and no design-system precedent
to inherit (native "starts custom, token-driven" per architecture.md:1979).

## Visual identity (decided, not specified upstream)

- **Primary accent — amber/gold.** `#C77D28` (daylight palette, AA against `#ffffff`), `#E8A94A` (cab
  palette, AA against `#0b0b0d`). Evokes a brass alarm bell/light. Chosen over red-as-primary because
  semantic red needs to stay rare in cab mode — real apparatus cabs use red lighting at night
  specifically to preserve night vision, so an amber/gold accent keeps red available exclusively for
  danger/error states without visual competition.
- **Semantic colors:** error/danger `#C41E3A` daylight / `#E05252` cab; success `#1F8A4C` / `#4CAF6D`;
  warning reuses the amber accent hue at higher saturation `#B8860B` / `#F0B860`.
- **Typography:** platform system fonts (SF Pro / Roboto via React Native's default, Inter on web) — no
  custom font loading or licensing surface, matches the doc naming "type scale" as a concept with no
  specified family. Scale: `xs 12 / sm 14 / base 16 / lg 20 / xl 24 / xxl 32 / display 40`, generous
  line-height (1.4+) for outdoor-glare and low-light legibility per N7.3 (architecture.md:2015).
- **Iconography:** Phosphor Icons (`phosphor-react-native`) — open-source, wide coverage, legible at
  small sizes, permissive license.
- **Corner radius:** 8px default, 12px for cards/modals — deliberately restrained, not playful, given
  life-safety context.
- **Touch targets:** 44×44pt (iOS) / 48×48dp (Android) baseline per N3.5 (architecture.md:2016);
  oversized (56pt+) specifically on the truck-check runner and alert-response screens, matching the
  doc's explicit callout that those are the screens most likely used gloved and in a moving vehicle.

Both palettes are independently AA-checked against WCAG 2.1 contrast minimums — not derived by
inverting one from the other, per architecture.md:2015's explicit requirement.

## Constraints carried from architecture.md (not decided here, just enforced)

- No shared component library between web and native (architecture.md:1876) — native components live
  in `apps/mobile/src/components`, themed from `@boxalarm/design-tokens`, built custom.
- Navigation: `AuthStack` (login/recovery, no MFA) + `AppTabs` (Alerts · Checks · Schedule · Me, bottom
  tab bar, glove-sized targets) per architecture.md:1915–1922. Incoming alert presents modally over
  whatever screen is active from the native notification handler, not a normal nav push
  (architecture.md:1928).
- Offline-first for Checks, Schedule (shift claims), field capture — optimistic local writes, outbox
  sync, shift claims show `pending` never falsely `confirmed` (architecture.md:2023–2031).
- WCAG 2.1 AA, per-screen axe-equivalent coverage (manual VoiceOver/TalkBack — no automated RN a11y
  tool exists per architecture.md:2021), live-region announcements on state transitions.

## Phases

Each phase is a merge-able unit. Phases 1–2 are pure token/re-skin work (no new screens). Phases 3–7
build the navigation shell and screen stacks in an order chosen so the earliest phases don't depend on
backend data that isn't accessible yet. Phase 7 (Alerts) is scoped to the self-test path only, since
real dispatch fan-out requires `boxalarm-backend`/`boxalarm-infrastructure` access this session does not
have. Phases 8–10 are cross-cutting hardening passes over everything built in 1–7.

1. **Design tokens** — typography scale, semantic colors, touch-target constants, icon re-export,
   radius/elevation, extending `packages/design-tokens`. Both palettes AA-verified with a written
   contrast-ratio check (not eyeballed).
2. **Re-skin auth** — apply phase 1 tokens to the existing sign-in screen (and credential-recovery
   affordance) on mobile, matching architecture.md's stated behavior (no MFA, no re-prompt, F9.1
   self-service recovery framing even though the recovery flow itself is a later phase's scope if it
   needs new screens beyond sign-in).
3. **Navigation shell** — install React Navigation, `AuthStack`/`AppTabs` split, 4-tab bottom bar
   (Alerts · Checks · Schedule · Me) at oversized touch targets, empty placeholder screens per stack
   wired up so the shell itself is navigable and testable before any screen has real content.
4. **Me stack** — profile (self-service update), certifications list, self-test entry point,
   diagnostics entry point. Static/local data only; no live backend dependency beyond the auth token
   already in place.
5. **Checks stack** — apparatus picker, check runner (optimistic local-first, <90s budget), defect
   report with photo. Built against a local mock data layer shaped like the eventual API (per
   `@boxalarm/core`'s stated role), so swapping in the real client later is a data-layer change, not a
   UI rewrite.
6. **Schedule stack** — shift board, shift detail/claim with explicit `pending` state, availability
   marking. Same mock-data-layer approach as phase 5.
7. **Alerts stack (self-test scope)** — alert detail, response confirmation, live roster + tone-ladder
   panel UI, wired to the self-test flow (a real, achievable round trip once Cognito/backend access
   exists) with the general dispatch-received path stubbed behind the same interface so it activates
   without a UI rewrite once backend access lands.
8. **Accessibility hardening** — VoiceOver/TalkBack walkthrough of every screen built in 1–7, touch-target
   audit against the oversized-target screens specifically, contrast re-verification in context (not
   just token-level), live-region announcement check on every async state transition.
9. **Offline/sync UX** — persistent sync-status banner (queued count, last-sync time), per-screen
   offline states, retry affordance on failed sync items — the UI half of `@boxalarm/core`'s contract,
   built against the same mock data-layer interface as phases 5–6 pending that package's real
   implementation.
10. **Web token parity** — apply phase 1's tokens to the existing web sign-in/landing pages and set up
    the CSS custom-property equivalent so the 15 web routes (not built in this spec's scope) inherit a
    consistent visual language when they are eventually built.

## Explicitly out of scope

- Real dispatch fan-out / live roster data (backend access blocker, unchanged from prior sessions).
- `@boxalarm/core`'s actual sync engine implementation (phases 5, 6, 9 build UI against a mock
  interface shaped to match it, not the engine itself).
- The 15 web SPA routes beyond sign-in/landing (phase 10 is tokens-only parity, not new web screens).
- Android build verification (no Java/Android SDK on this machine, same limitation as PR #4).
- A `@moonaan` shared native component library — architecture.md names this as an open question
  (architecture.md:1979, :2038) and assumes none exists; not resolved here.
