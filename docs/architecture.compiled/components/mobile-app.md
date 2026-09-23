# mobile-app

## Purpose & Boundaries
React Native app (New Architecture), one shared codebase for iOS + Android, at `apps/mobile` in `boxalarm-ui`. This is the life-safety alert path of record (N1, N3.1) - iOS Critical Alerts and Android full-screen intent are OS entitlements no web app or PWA can obtain, so native is mandatory, not a platform preference. Bare React Native, not Expo managed workflow (the entitlement/manifest requirements need native module code Expo managed can't own without ejecting).

## Interfaces
Bottom tab bar (Alerts, Checks, Schedule, Me), each a native stack; the incoming full-screen alert is presented modally over the current stack from the native notification handler, not a normal navigation push. Consumes the same REST APIs as `web-spa` via `@boxalarm/core`, plus is the sole registrant of native push tokens (`contactChannels` in `MEMBER_ELIGIBILITY_SNAPSHOT`).

Hand-written native modules (the only native code in the project; everything else is shared TS/RN):
- iOS: Notification Service Extension (intercepts APNs push, applies critical-alert flag, enriches content; runs even if the app is force-quit) + Notification Content Extension (renders the full-screen alert UI from the lock screen).
- Android: native Kotlin `FirebaseMessagingService` (receives high-priority data messages even when killed/battery-optimized) + foreground service + full-screen-intent notification on a dedicated `IMPORTANCE_HIGH` channel.

## Data Ownership
None server-side. Local-first SQLite store (`op-sqlite` or WatermelonDB, final pick deferred - both satisfy N3.4) backing an outbox sync queue for truck checks (F4.2), defect reports (F4.3), inspections (F6.3/F6.5), attendance capture (F2.3), and shift claims (F2.9). Refresh tokens (3650-day ceiling) held in Keychain/Keystore.

## Events Produced
None directly (client). Outbox entries carry client-generated idempotency keys so a retried push after partial failure cannot double-submit.

## Events Consumed
None directly - receives APNs/FCM pushes from `alerting-service`'s channel workers and `notification-service`'s non-critical channel (distinct notification channel ID, never the Critical Alerts channel).

## Dependencies
- Internal: `@boxalarm/core`, `@boxalarm/design-tokens`, `@boxalarm/i18n` (shared packages). Backend: `alerting-service` (alert receipt, response confirmation, self-test), `platform-service`/Cognito (auth), all other services for their respective screens.
- External: APNs (Critical Alerts entitlement - ownership/timeline unresolved, OQ-4), FCM (high-priority data messages), `react-native-app-auth` (Cognito OIDC PKCE via system browser - resolved as the only credible RN choice, ratified not re-deliberated), `react-native-keychain`.

## Gotchas & Constraints
- **Notification identity is `{dispatchId}#{toneSequence}` on both platforms, never `dispatchId` alone** - iOS `apns-collapse-id` and the Android notification id passed to `NotificationManager.notify()`. A `dispatchId`-only identity lets the OS coalesce a tone-2 push into tone-1's existing notification silently - no second buzz, receipt still says "delivered." Every tone must present as new, even if tone 1 is still on screen or already answered.
- The native notification handler has no special case for "a dispatch I've already shown," only for "a `{dispatchId}#{toneSequence}` I haven't shown yet" - this is what makes always-new-tone-always-presents fall out of the existing mechanism rather than requiring new logic.
- Alert delivery must not depend on the app being foregrounded, recently opened, or exempt from battery optimization (N3.7) - the OS-registered native extension/service is the mechanism, not a fallback; the RN JS layer only takes over once the user taps into the alert.
- Shift claims made offline are shown as *pending*, never confirmed, until server round-trip confirms/rejects - the one genuinely contended write (F2.9 atomic claim), called out because offline-optimism would otherwise mislead a volunteer into believing a shift is theirs.
- No idle timeout, no MFA, no step-up re-authentication anywhere - login screen reached only on first sign-in or explicit sign-out (Cross-Cutting - Session and re-authentication policy).
- Native touch targets minimum 48x48dp (Android) / 44x44pt (iOS), exceeding platform minimums for gloved operation, with extra spacing on the truck-check runner and response-confirm screens.
- N3.7 is tested on real devices, not simulators alone, in a background-app-killed + battery-optimization-enabled state - simulator/emulator tests cover the code path but are explicitly not sufficient proof on their own.

## Source Sections
- Frontend section 1 Topology rationale (native mandatory), lines 1747-1753
- Frontend section 3 Native code-sharing strategy, lines 1815-1822
- Frontend section 4.2 Native app component hierarchy, lines 1852-1873
- Frontend section 5 Native platform specifics (iOS 5.1, Android 5.2, background delivery 5.3, self-test/diagnostics 5.4), lines 1875-1898
- Frontend section 9 Offline and sync strategy, lines 1968-1976
- Testing section 7 Mobile/Native Test Approach, lines 2399-2421
- Cross-Cutting - Session and re-authentication policy, lines 2500-2501
