# Push: device verification checklist

The direct APNs/FCM push path (`feat/direct-push`) is covered by unit and contract tests, but several links can only be proven on a real phone. Run every item on a **release build** (TestFlight for iOS, a signed release APK/AAB for Android). Bridgeless mode is the React Native 0.87 default, so that is what gets tested.

Send each page from the stack under test (a manual dispatch or a self-test), with the stack's APNs secret `environment` matching the build (see `infrastructure/README.md`, "Push credentials").

## iOS

| # | Check | Pass when |
|---|---|---|
| 1 | Page with the app **killed**, phone locked | Banner and sound appear. With `interruptionLevel: time-sensitive`, the page also breaks through a Focus mode. |
| 2 | Page with the phone in **Sleep Focus** and the ring/silent switch on silent | `time-sensitive`: delivered through Focus. `critical` (only after #4 is granted and the member has allowed Critical Alerts): plays at full volume despite the switch. |
| 3 | Page with the app **open in the foreground** | A banner and sound are shown (AppDelegate `willPresent`). |
| 4 | **Cold-start tap**: kill the app, page, tap the notification | The app opens on that dispatch's alert detail. |
| 5 | **Warm tap, background**: app backgrounded (not killed), page, tap | The app comes forward on that dispatch's alert detail. This path depends on React Native's `settingsUpdated` event reaching JS in bridgeless mode (`pushRouting.ts`). If it does not, the app opens but stays on the current screen, and a native Linking fallback is needed. |
| 6 | **Warm tap, foreground**: app open on another screen, page, tap the banner | The app navigates to that dispatch's alert detail. Same dependency as 5. |
| 7 | Tone 2 while the tone-1 notification is still showing | A second, separate alert fires (per-tone `apns-collapse-id`). |
| 8 | Signing | The Time Sensitive Notifications capability is enabled on the App ID and present in every provisioning profile. Otherwise the signed build fails. |

## Android

| # | Check | Pass when |
|---|---|---|
| 9 | Page with the app killed, screen off, Do Not Disturb on, **DND access granted** | A full-screen dispatch notification appears on the `dispatch-critical-v2-dnd` channel, over the lock screen, and the alarm sound plays through DND. |
| 10 | Page with the app **open in the foreground** | The same notification is posted (the `onMessage` handler). |
| 11 | Tap on the notification: app cold, app warm | The app opens on that dispatch's alert detail. |
| 12 | Phone offline for more than 10 minutes, then back online | Old pages do **not** ring (600s TTL). |

## Alert experience (`fix/mobile-alert-screen`)

None of this could run in CI (no Xcode or Android SDK there): the Kotlin module, manifest, MainActivity and AppDelegate changes were written without compiling. Run it on **a Pixel (Android 14 or 15), a Samsung (One UI 6+, Android 14+) and an iPhone (iOS 17+)**, release builds.

### Build and first run

| # | Device | Check | Pass when |
|---|---|---|---|
| 13 | Pixel, Samsung | The release build compiles and starts | `AlertReadinessModule`/`AlertReadinessPackage` compile, the module is reachable from JS in bridgeless mode (`NativeModules.BoxalarmAlertReadiness` is not undefined - the readiness checklist shows DND / full-screen rows as Ready or Fix, never "Unknown"). If it is undefined under the new architecture, the legacy-module interop is not picking it up and the module needs a TurboModule spec. |
| 14 | Pixel, Samsung (upgrade install over a build with `dispatch-critical`) | Settings > Apps > Boxalarm > Notifications | Only `Dispatch pages` (`dispatch-critical-v2` or `-v2-dnd`) and `Notifications` exist; the old `Dispatch alerts` channel is gone (stale channels are deleted on app start/foreground only, never while posting a page). |
| 14a | Pixel | Grant DND access, set `Dispatch pages` to Silent, revoke DND access, return to the app, re-grant it | **Known Android behaviour:** re-creating a deleted channel id restores the member's old settings for it, so the channel comes back Silent. The readiness banner must name "Dispatch page sound" as silent. |
| 15 | Pixel, Samsung | Channel sound | The `Dispatch pages` channel's sound is the phone's **alarm** sound, and it plays on the alarm volume (turn media and ringer volume to 0, alarm volume up: the page is still loud). No fire-tone asset exists in the repo; bundling one is a follow-up (`res/raw` + `.caf`). |

### Do Not Disturb, Bedtime, full-screen (Android)

| # | Device | Check | Pass when |
|---|---|---|---|
| 16 | Pixel, Samsung | Fresh install, sign in, open Alerts | Red banner "This phone may not wake you for a page" names "Ring through Do Not Disturb" (and, on Android 14+, full-screen if not granted). |
| 17 | Pixel, Samsung | Banner Fix → guided dialog → Open settings | The system "Do Not Disturb access" list opens; after allowing Boxalarm and returning, the banner line clears and the channel is now `dispatch-critical-v2-dnd` (Settings shows its "Override Do Not Disturb" on). On Samsung check the list is reachable (One UI sometimes files it under "Apps that can interrupt"); if the intent fails, the fallback opens the app's notification settings. |
| 18 | Pixel | **Bedtime mode** on, screen off, app killed, page | Screen turns on, full-screen alert shows over the lock screen, alarm sound loops until answered, Silence is tapped, the notification is dismissed, or **about 60 s** pass - then the page stays in the shade, silent, with its three answer buttons (the cap is a notifee timestamp trigger without AlarmManager, so under Doze it may fire late: record how late). |
| 18a | Pixel | Page, then **swipe the notification away** within 60 s | It does **not** come back at the 60 s mark (the dismiss cancels the cap); the call is still listed on the Alerts tab. |
| 19 | Samsung | **Do Not Disturb** on (and separately **Sleep mode**), screen off, page | Same as 18. Also run once with battery optimization on (default) and once with Boxalarm set to "Unrestricted". |
| 20 | Pixel, Samsung (Android 14+) | Revoke "Full screen notifications" for Boxalarm, page with screen off | Readiness banner names full-screen; the page falls back to a heads-up (not silent). Fix button opens the per-app full-screen setting (`ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT`). |
| 21 | Pixel, Samsung | After the full-screen alert, press back / switch to another tab, then lock and wake the phone | The rest of the app is **not** shown over the lock screen (cleared by the navigation-state check once no alert is focused). Open the app normally while unlocked, lock, wake: the keyguard shows, not the app. |
| 21a | Pixel, Samsung | **Second page while locked**: leave the app on call A's alert screen, lock the phone, page call B | Screen turns on and call B's alert (B's address) shows **over the lock screen and keeps ringing** until answered, Silence is tapped, or the notification is dismissed. It must not flash and drop back to the keyguard, and the notification must not disappear. Back from B shows A underneath. |
| 21b | Pixel | Page while unlocked with the app open on another tab | The alert opens and the alarm stops on its own (unlocked + app active); with the phone locked it keeps ringing until the member acts. |
| 21c | Pixel, Samsung | **Warm app, locked, on another tab** (review m2-1): open the app, go to the Schedule tab, lock the phone, page | The page's full-screen launch must show **the call**, not the Schedule tab, over the keyguard. Known risk: if notifee raises no press event for a full-screen launch of a running app, no navigation happens and the Schedule tab shows over the keyguard until the next navigation (the page still rings; the call is reachable from the Alerts tab). Record what happens; if the tab shows, the fix is to route to the newest ringing `dispatch:` notification on `AppState` active (not in this branch). |
| 21d | Pixel, Samsung | **Answered alert over the lock screen** (review m2-2 / R3-1): with the phone locked, answer a page on its full-screen alert and see "Sent" | The call (address, VERIFY ADDRESS, narrative, map, ETA chips) **stays** over the keyguard while you use it - tap an ETA chip, scroll. It is released when the screen turns off, the app is left, or 10 minutes pass without a touch; waking the phone then shows the keyguard. Tapping a *different* answer while locked asks "Change your answer to ...?" first (ETA changes do not ask). With the answer still "Not sent yet" (airplane mode) it is never released by this rule. |

### Answering from the notification

| # | Device | Check | Pass when |
|---|---|---|---|
| 22 | Pixel, Samsung | Locked phone, app killed, page, tap **Responding** (and separately **Direct to scene**) on the notification (no unlock) | The alarm stops; the notification is replaced by "Responding — ... Sent." within a few seconds; the officer's roster shows Responding with **no ETA** against a server with the page-chain responses change (the app sends `eta: null`). Against an older server the app gets a 400 naming `eta` and re-sends once with a 10-minute placeholder flagged `etaSource: NOT_GIVEN`; the phone still shows "ETA ?". Record which server the build was tested against. |
| 23 | Pixel, Samsung | Same with airplane mode on | Notification says "NOT SENT YET - saved on this phone"; turn airplane mode off and open the app: the answer drains and the alert screen shows "Sent". |
| 24 | Pixel | Responding from the notification, then open the call and change to Not responding | Roster ends on Not responding (the newer answer is never overtaken by the older one). |
| 25 | iPhone | **iOS answer buttons are inert until the alerting service sends `aps.category = "DISPATCH"`** (page-chain backend work; not in this branch). Then: Long-press a page, tap Responding | Face ID / passcode, the app opens on the call with Responding selected and "Sent". Until the backend sends the category, no buttons appear - record that as expected. |

### Alert screen and list

| # | Device | Check | Pass when |
|---|---|---|---|
| 26 | All | Airplane mode, then tap a page (Android) / a delivered page (iPhone) | The address and incident type paint immediately from the page; the narrative area says it couldn't load, with the reassurance and a Retry; the answer buttons work and show "Not sent yet". Never a blank screen. |
| 27 | All | Swipe the page notification away, open Boxalarm | The call is listed on the Alerts tab and opens. Offline, the last list is shown with its "saved at" time. |
| 28 | iPhone | Cold-start tap on a page | Address shows at once from the explicit keys AppDelegate copies (incidentType, address, crossStreets, dispatchedAt); the strip reads "DISPATCHED {server dispatch time}". Against a server without those keys it falls back to the body and "RECEIVED {delivery time}", never the tap time. |
| 28a | iPhone | **Known gap:** swipe a page away without tapping it, go offline, open Alerts | The page is **not** in the offline list: there is no Notification Service Extension, so iOS never runs app code on receipt and nothing is cached until a tap. Expected until the NSE (design review R0) is built. |
| 29 | All | VoiceOver / TalkBack on, page arrives, open it | "Incoming call. {type} at {address}... Are you responding?" is spoken first; focus is on the header; the rotor offers Responding / Direct / Not responding; after answering, the button reads its delivery state. |
| 30 | iPhone | Settings > Notifications > Boxalarm set to **Deliver Quietly** (provisional); separately, **Sounds** off | The red readiness banner (on every tab except an open call) names notifications as delivered quietly / sounds off. |
| 30a | Pixel, Samsung | Set the `Dispatch pages` channel to Silent; separately lower it to "Default"/"Low"; separately turn off its "Override Do Not Disturb" | Each raises the red banner with the matching reason and an "Open channel settings" fix. |
| 31 | iPhone | **Silent switch on + Sleep Focus**, page | Time-sensitive: breaks through Sleep Focus if allowed, but **no sound on silent** - expected until Critical Alerts (#4). The self-test "Did your phone ring?" → No path tells the member to set the switch to ring. |
| 32 | All | Me > Test my alert path | Checklist rows match the device state; after the test page, "Did your phone ring?" is asked; "No" lists the failing checks. |
| 33 | All (two devices signed in as the same member) | Me > Sign out on one device, confirm; then page | The confirmation says "Boxalarm pages stop on this phone until you sign in again; your other signed-in devices keep getting pages" and mentions text/voice only conditionally; "Stay signed in" is the default. After signing out, the page still rings on the **other** device and not on this one (multi-device push, fix/page-chain). |

Record the device model, OS version, build number and stack for each run in the release notes.
