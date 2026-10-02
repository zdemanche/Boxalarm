# Mobile App

## Purpose & Boundaries
Bare React Native (New Architecture) iOS+Android app (`apps/mobile`) — the alerting path of record replacing radio tone-out. Native Swift/Kotlin notification layer (only hand-written native code): iOS Notification Service Extension + Notification Content Extension; Android native `FirebaseMessagingService` + foreground service. Offline-first for checks, defects, inspections, attendance, shift claims. Not offline-capable: live roster (F1.7), NERIS submission (F7.6).

## Interfaces
Bottom tabs: Alerts · Checks · Schedule · Me (stacks: AlertsStack [incoming alert, detail, response confirm, live roster], ChecksStack, ScheduleStack, MeStack [profile, certs, self-test, diagnostics], SyncStatusScreen). Incoming full-screen alert is presented from native handler over any screen incl. lock screen (not a nav push). AuthStack reached on first sign-in only. Push deep links route to AlertsStack -> AlertDetail. Calls alerting `POST /devices/state`, push-token register/remove, `POST /dispatches/{id}/responses` (sends `now + minutes*60` epoch-second ETA, optional, echoes toneSequence), self-test.

## Data Ownership
Local SQLite (op-sqlite or WatermelonDB; pick deferred) + outbox sync queue with client idempotency keys; tokens in Keychain/Keystore (holds 3650-day refresh token).

## Events Produced
absent — the source document does not address this.

## Events Consumed
APNs/FCM pushes: dispatch alerts (Critical channel) and notification-service pushes (separate non-critical channel); `alertKind: "mutual_aid_prompt"` renders actionable prompt; non-escalating CAD UPDATE push (ordinary channel).

## Dependencies
internal: ui-shared-packages, alerting-service, notification-service, apparatus/personnel/inspections services. external: APNs (Critical Alerts entitlement), FCM, react-native-app-auth, react-native-keychain, React Navigation, Cognito.

## Gotchas & Constraints
- iOS `apns-collapse-id` and Android notification id MUST be `{dispatchId}#{toneSequence}` (never dispatchId alone) so each tone presents distinctly even if tone 1 still on screen or answered; native handler has no "already shown dispatch" special case.
- Alert receipt must not depend on foreground/battery-optimization exemption (N3.7); FCM high-priority DATA messages; native code, not RN JS.
- APNs delivery level = secret's `interruptionLevel` (code default `critical`; first-deploy sets `time-sensitive` until entitlement granted; `time-sensitive` doesn't override silent switch; neither verified in Sleep Focus — `docs/runbooks/push-device-verification.md` is a release gate). Entitlement `com.apple.developer.usernotifications.critical-alerts`.
- Android full-screen intent `CATEGORY_CALL`, `IMPORTANCE_HIGH` channel; DND bypass user-granted at onboarding.
- Touch targets >=48dp / 44pt; one installation id per app install kept in keychain; sign-out removes only that device's push entry; offline shift claim shown pending until server confirms.
- Silent refresh on foreground and 401; never renders login after first sign-in.
- Whether `react-native-app-auth` is the approved lib is ratified in Open Questions; Native a11y manual (VoiceOver/TalkBack) each release.

## Source Sections
Frontend §2-3 (1970-2037); §4.2 (2067-2088); §5 native (2090-2113); §7.2 (2165-2169); §9 offline (2183-2191); Backend multi-device push (223-228); Testing §7 (2626-2648)
