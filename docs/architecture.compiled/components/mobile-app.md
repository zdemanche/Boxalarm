# Mobile App

## Purpose & Boundaries
Bare React Native (New Architecture) iOS+Android app (`apps/mobile`) — the alerting path of record; native iOS/Android mandatory (N3.1). Hand-written native layer only: iOS Notification Service Extension + Content Extension (Swift), Android `FirebaseMessagingService` + foreground service (Kotlin); these run outside JS, so alert receipt is independent of foreground/battery exemption (N3.7). Offline-first for truck checks, defects, inspections, attendance, shift claims.

## Interfaces
Navigation: `RootNavigator > AuthStack` (login, recovery; first sign-in only) `/ AppTabs` (Alerts, Checks, Schedule, Me; AlertsStack, ChecksStack, ScheduleStack, MeStack, SyncStatusScreen). Incoming full-screen alert presented from native handler over any screen, not a nav push; push deep link -> `AlertsStack > AlertDetail`. Self-test ("Test my alert path") in MeStack; member diagnostics (permissions, battery exemption, versions) posted to `/alerting/devices/state`.

## Data Ownership
Local SQLite (op-sqlite or WatermelonDB, pick open) + outbox sync queue; each outbox entry carries client idempotency key. Tokens in Keychain/Keystore (3650-day refresh).

## Events Produced
absent — the source document does not address this

## Events Consumed
absent — the source document does not address this (receives APNs/FCM pushes; payload `alertKind` `dispatch` | `mutual_aid_prompt`)

## Dependencies
internal: shared packages `@boxalarm/core`, `@boxalarm/design-tokens`, `@boxalarm/i18n`; alerting-service, apparatus-service, personnel-service. external: `react-native-app-auth` (ratified; PKCE system browser), `react-native-keychain`, `@tanstack/react-query` (persisted), jotai, i18next, React Navigation, APNs/FCM.

## Gotchas & Constraints
- iOS: Critical Alerts entitlement `com.apple.developer.usernotifications.critical-alerts` pending; `interruption-level` critical (code default) or `time-sensitive` until granted (does not override silent switch); unverified in Sleep Focus (release gate `docs/runbooks/push-device-verification.md`).
- **`apns-collapse-id` = `{dispatchId}#{toneSequence}`; Android notification id derived from `{dispatchId}#{toneSequence}`** — never dispatchId alone (else tone 2 swallowed). Native handler treats unseen `{dispatchId}#{toneSequence}` as new presentation.
- Android: full-screen intent, `CATEGORY_CALL`, high-priority channel `IMPORTANCE_HIGH`, DND bypass user-granted; FCM high-priority DATA messages; battery exemption requested but delivery must not depend on it.
- Registers one PUSH entry per installation (stable installation id in keychain); sign-out removes that device only.
- Touch targets >=48dp/44pt; no animation on incoming-alert screen; shift claims offline show PENDING, never confirmed; live roster and NERIS submit not offline.
- Pending claims, sync failures surface per item with retry, never silent. Native a11y manual (VoiceOver/TalkBack) each release; real-device N3.7 test required.

## Source Sections
Frontend §1–3 1962–2037; §4.2 2067–2088; §5 native 2090–2113; §9 offline 2183–2191; Testing §7 2626–2648.
