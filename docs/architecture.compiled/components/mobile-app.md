# mobile-app

## Purpose & Boundaries

React Native app (iOS + Android, shared codebase, New Architecture, bare workflow not Expo managed) — the life-safety alert delivery surface and the field-usage surface (truck checks, schedule, self-service). **Native is mandatory, not a platform choice (N3.1):** iOS Critical Alerts and Android full-screen intent/high-priority channels are OS entitlements no browser or PWA can obtain, and N1 (alert fan-out) cannot be met without them. Lives in `boxalarm-ui` repo, `apps/mobile` workspace.

## Interfaces

Bottom tab bar: **Alerts · Checks · Schedule · Me**, each a native stack (React Navigation). The incoming full-screen alert is presented modally over the current stack from the native notification handler, not a normal navigation push — interrupts whatever the volunteer was doing, matching phone-call UI behavior.

Consumes: `AlertAPI` (alerting-service — dispatch responses, self-test, live roster), `CoreAPI` (platform-service + LOB services — checks, schedule, profile), `AuthAPI` (Cognito).

## Data Ownership

**Local-first SQLite store** (op-sqlite or WatermelonDB — final pick deferred to implementation, both satisfy N3.4) backing an outbox sync queue for: truck checks (F4.2), defect reports (F4.3), inspections (F6.3/F6.5), attendance capture (F2.3), shift claims (F2.9). Every mutating action writes locally first (optimistic UI), then enqueues for background sync on connectivity regain. Not owned/persisted server-side by this component — see the corresponding backend service for the durable record.

## Events Produced / Consumed

None directly — all interaction goes through REST APIs; push delivery is inbound via native OS notification handlers (APNs/FCM), not an app-level event subscription.

## Dependencies

**Internal:** `alerting-service` (critical path — response confirmation, self-test, live roster), all LOB services via `CoreAPI`. Shared packages: `@boxalarm/core`, `@boxalarm/design-tokens`, `@boxalarm/i18n`.

**External:** APNs (Critical Alerts entitlement — **OQ-4, unresolved, who applies is unowned**), FCM (high-priority data messages), `react-native-app-auth` (Cognito OIDC PKCE via system browser — **flagged as an assumption**, `oidc-client-ts` is DOM-bound and unsuitable for RN, no confirmed Moonaan mobile-auth standard exists), `react-native-keychain` (token storage, holds the 3650-day refresh token).

## Gotchas & Constraints

- **Notification identity must be `{dispatchId}#{toneSequence}`, never `dispatchId` alone (B4, amendment).** iOS `apns-collapse-id` and the Android notification id both need this — a dispatchId-only id lets the OS silently coalesce a tone-2 push into tone-1's existing notification (no second Critical Alert re-fire, no second buzz, the delivery receipt still correctly says "delivered") — the identical backend-swallow defect this amendment fixed, reproduced one layer down at the device. Every tone must get its own presentation, even if tone-1's alert is still on screen or already answered.
- **Notification handling is OS-registered native code (Swift Notification Service Extension on iOS, Kotlin `FirebaseMessagingService` + foreground service on Android), not RN JS** — this is the mechanism, not a fallback, satisfying N3.7 ("must not depend on app foregrounded/recently opened/battery-exemption granted"). RN JS only takes over once the user taps into the alert.
- **Android full-screen intent DND bypass is a user-grantable permission, not automatic** — onboarding must walk the volunteer through granting it explicitly; the exemption prompt is a reliability improvement, never a requirement gate (delivery must work without it).
- **This is the only hand-written native (Swift/Kotlin) code in the project** — everything else (screens, navigation, offline queue, forms) is shared TypeScript/RN.
- **Shift claims are the one genuinely contended offline write** — a claim made offline is shown as *pending*, never confirmed, until server round-trip confirms or rejects it; offline-optimism here would mislead a volunteer into believing a shift is theirs when it might not be.
- **Live response roster (F1.7) and NERIS submission (F7.6) are explicitly NOT offline-capable** — they require real connectivity by nature and show a clear "offline, will resume" state.
- **Outbox entries carry a client-generated idempotency key** so a retried push after partial failure cannot double-submit a check or defect report — same discipline as F1.5's alert-dispatch idempotency, applied to the sync write side.
- **Sign-in is once-and-forget:** `AuthProvider` never renders a login screen after first sign-in; silent refresh on foreground and on 401; the 3650-day refresh token lives in Keychain/Keystore. No idle timeout, no MFA, no step-up anywhere.
- **Touch targets:** minimum 48×48dp (Android)/44×44pt (iOS), exceeding platform minimums for gloved operation, with extra spacing on the truck-check runner and response-confirm screens specifically.
- **`react-native-app-auth` is an unconfirmed assumption**, not a ratified Moonaan mobile-auth standard (though later resolved in Open Questions as the only credible choice — see spine).
- **Whether a `@moonaan` RN shared component library exists is unresolved** — native UI currently starts custom, token-driven from `@boxalarm/design-tokens`.

## Source Sections

- Frontend Architecture §1 Topology rationale — native mandatory (`:1870-1877`)
- Frontend Architecture §2-3 Application topology, native code-sharing strategy (`:1878-1946`)
- Frontend Architecture §4.2 Native app component hierarchy (`:1975-1996`)
- Frontend Architecture §5 Native platform specifics (iOS/Android/N3.7) (`:1998-2021`)
- Frontend Architecture §6 Shared dependency list (`:2023-2047`)
- Frontend Architecture §7.2 Native navigation (`:2073-2077`)
- Frontend Architecture §9 Offline and sync strategy (`:2091-2099`)
- Frontend Architecture Open questions (mobile OIDC, entitlement ownership, RN component lib, offline store pick) (`:2101-2113`)
- Testing Architecture §7 Mobile/Native Test Approach, re-tone re-presentation test (`:2522-2544`)
