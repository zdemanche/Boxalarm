# Boxalarm — Design-Time Accessibility Specification

**Version:** 0.1 (draft, design-time)
**Date:** 2026-09-06
**Floor:** WCAG 2.1 AA, satisfied by construction. Where the "Command console" direction conflicts with AA, AA wins; every conflict is recorded in §7 for PRD section 10.
**Surfaces:** `apps/web` (React 19 + Vite, `react-vite` target) and `apps/mobile` (React Native, not prototyped in this run — this document is the only thing standing behind it).
**Coverage:** 15 web routes + 15 native screens = 30 screens × 7 states = **210 screen×state cells**, all specified in §4 and §5.

Two rules override every other statement in this document:

1. **Nothing on the alert path may present a sign-in, re-authentication, session-expiry, or second-factor interaction.** There is no session expiry in this product (F9.1, N5.2). No state in this specification is "signed out mid-task."
2. **Colour is never the sole carrier of status.** Every status in §1.8 carries hue + glyph + border style + text. A monochrome screenshot of any Boxalarm screen must still be readable.

---

## 1. Global foundations

These are specified once and are binding on every screen. Per-screen sections in §4/§5 name the *instance* (which element, which string, which politeness), never re-derive the pattern.

### 1.1 Token additions required

`packages/design-tokens` today holds only `palette.day`, `palette.cab`, and `spacing`. Everything below is net-new and must be added as named tokens before any component is built. No hardcoded values anywhere (Token Discipline). All new tokens carry `provenance: inferred` and are surfaced in PRD section 10.

**Palette scaffolding (both palettes mandatory, neither is a dimmed variant of the other):**

| Token | `cab` | `day` |
|---|---|---|
| `color.bg` | `#0b0b0d` (existing) | `#ffffff` (existing) |
| `color.surface` | `#16171a` | `#f4f5f7` |
| `color.surface.raised` | `#1f2126` | `#eceef1` |
| `color.fg` | `#d6d8dd` (existing) | `#101114` (existing) |
| `color.fg.muted` | `#a3a8b2` | `#4d525b` |
| `color.fg.faint` | `#7c828d` | `#5b616b` |
| `color.border` | `#6b7078` | `#767b85` |
| `color.border.strong` | `#9aa0aa` | `#4d525b` |
| `color.border.decorative` | `#2a2d33` | `#e4e6ea` |
| `color.focus` | `#ffd166` | `#101114` |
| `color.focus.gap` | `#0b0b0d` | `#ffffff` |
| `color.status.danger` | `#ff6b5e` | `#c02418` |
| `color.status.warn` | `#ffc247` | `#6f4c00` |
| `color.status.caution` | `#ff9b3d` | `#8a4a00` |
| `color.status.ok` | `#5ddb8a` | `#0f6c34` |
| `color.status.info` | `#7cc4ff` | `#0b57d0` |
| `color.skeleton` | `#2a2d33` | `#e4e6ea` |

**Typography tokens** (none exist today). System stack: `-apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`; native uses the platform default face. Sizes are in CSS px on web / dp on native; all must scale with the OS text-size setting (see §1.11).

| Token | Size / line-height / weight | Used for |
|---|---|---|
| `type.alert.address` | 32 / 38 / 700 | Alert-path address only (brand direction) |
| `type.alert.type` | 24 / 30 / 700 | Incident type on the alert |
| `type.display` | 28 / 34 / 700 | Screen `h1` on native alert screens |
| `type.h1` | 24 / 32 / 700 | Web page title |
| `type.h2` | 20 / 28 / 600 | Section |
| `type.h3` | 17 / 24 / 600 | Sub-section, card title |
| `type.body` | 16 / 24 / 400 | Default body — never smaller in field posture |
| `type.body.dense` | 15 / 22 / 400 | Office posture data tables only |
| `type.label` | 14 / 20 / 600 | Form labels, chip text |
| `type.caption` | 13 / 18 / 400 | Timestamps, helper text — office posture only; **prohibited in field posture** |

`type.caption` at 13px is the smallest size in the system and is never used for anything a gloved user must read at 03:00.

**Motion tokens:** `motion.micro` 150ms, `motion.transition` 250ms, `motion.enter` 350ms, `motion.easing.standard` `cubic-bezier(.2,0,0,1)`, `motion.reduced` 0ms. All are gated on §1.9.

**Radius:** `radius.sm` 4, `radius.md` 8, `radius.lg` 12, `radius.pill` 999.

**Target-size tokens:** `target.min` 44, `target.field` 56, `target.alert` 72, `target.gap` 8, `target.gap.field` 12.

### 1.2 Contrast-safe pairings (computed)

All ratios below are computed with the WCAG 2.x relative-luminance formula. Every pairing listed is a permitted pairing; **any pairing not listed here is not approved.**

**`cab` palette — text on `color.bg` `#0b0b0d`:**

| Foreground | Hex | Ratio | Verdict |
|---|---|---|---|
| `color.fg` | `#d6d8dd` | **13.79:1** | AAA body |
| `color.fg.muted` | `#a3a8b2` | **8.24:1** | AA body |
| `color.fg.faint` | `#7c828d` | **5.09:1** | AA body — floor for cab secondary text |
| `status.danger` | `#ff6b5e` | **7.04:1** | AA body |
| `status.caution` | `#ff9b3d` | **9.37:1** | AA body |
| `status.warn` | `#ffc247` | **12.23:1** | AAA body |
| `status.ok` | `#5ddb8a` | **11.20:1** | AAA body |
| `status.info` | `#7cc4ff` | **10.48:1** | AAA body |
| `color.focus` | `#ffd166` | **13.64:1** | Focus ring, ≫3:1 |
| `color.border` | `#6b7078` | **3.95:1** | Meaningful non-text ✓ |
| `color.border.strong` | `#9aa0aa` | **7.48:1** | Input borders ✓ |

**`cab` — text on `color.surface` `#16171a`** (surface itself is 1.10:1 vs bg — decorative only, never the sole boundary of a control; every card also carries a `color.border` 1px edge):

| Foreground | Ratio | Verdict |
|---|---|---|
| `color.fg` `#d6d8dd` | **12.57:1** | AAA |
| `color.fg.muted` `#a3a8b2` | **7.51:1** | AA |
| `color.fg.faint` `#7c828d` | **4.64:1** | AA body (floor) |
| `status.danger` `#ff6b5e` | **6.42:1** | AA |
| `status.info` `#7cc4ff` | **9.56:1** | AAA |
| `#ffffff` alert address | **17.92:1** | AAA |

**`cab` — text on `color.surface.raised` `#1f2126`:** `fg` 11.29:1, `fg.muted` 6.75:1, `fg.faint` 4.17:1 — **`fg.faint` fails AA body on raised surface; on `surface.raised` the secondary-text token is `fg.muted` (6.75:1), not `fg.faint`.** Input placeholder `#a3a8b2` 6.75:1 ✓; input border `#9aa0aa` 6.12:1 ✓; error border `#ff6b5e` 5.77:1 ✓.

**`day` palette — text on `#ffffff`:**

| Foreground | Hex | Ratio | Verdict |
|---|---|---|---|
| `color.fg` | `#101114` | **18.88:1** | AAA |
| `color.fg.muted` | `#4d525b` | **7.85:1** | AA |
| `color.fg.faint` | `#5b616b` | **6.24:1** | AA |
| `status.danger` | `#c02418` | **5.99:1** | AA |
| `status.caution` | `#8a4a00` | **6.86:1** | AA |
| `status.warn` | `#6f4c00` | **7.75:1** | AA |
| `status.ok` | `#0f6c34` | **6.53:1** | AA |
| `status.info` / focus-inner | `#0b57d0` | **6.39:1** | AA |
| `color.border` | `#767b85` | **4.25:1** | Meaningful non-text ✓ |
| `color.border.strong` | `#4d525b` | **7.85:1** | ✓ |

**`day` — on `color.surface` `#f4f5f7`:** `fg` 17.31:1, `fg.muted` 7.20:1, `fg.faint` 5.72:1, `danger` 5.49:1, `ok` 5.99:1, `info` 5.85:1, `border` **3.90:1** ✓.

**Status chips — fill + label (both palettes). Fill-versus-page contrast is intentionally low (1.1–1.8:1); the chip's boundary is carried by a 1px `color.border` stroke at ≥3.9:1, never by the fill.**

| Chip | Palette | Fill | Label | Label:fill |
|---|---|---|---|---|
| Responding | cab | `#0c3f22` | `#d6f5e2` | **10.30:1** |
| Responding | day | `#e3f5ea` | `#0b4f26` | **8.57:1** |
| Not responding / failed | cab | `#7a1109` | `#ffe9e6` | **9.44:1** |
| Not responding / failed | day | `#fde7e5` | `#8c1a10` | **7.81:1** |
| Pending / warn / offline | cab | `#4a3300` | `#ffeec2` | **10.35:1** |
| Pending / warn / offline | day | `#fdf0d5` | `#5a3d00` | **8.85:1** |
| Info / queued | cab | `#0a2c4a` | `#d9ecff` | **11.82:1** |
| Info / queued | day | `#e5efff` | `#0a459f` | **7.66:1** |
| Neutral / marked off | cab | `#26282e` | `#d6d8dd` | **10.33:1** |
| Neutral / marked off | day | `#eceef1` | `#33383f` | **10.16:1** |

**Buttons:**

| Button | Palette | Fill | Label | Label:fill | Fill:page |
|---|---|---|---|---|---|
| Primary (`Responding`) | cab | `#35a862` | `#0b0b0d` | **6.49:1** | **6.49:1** |
| Primary | day | `#0f6c34` | `#ffffff` | **6.53:1** | **6.53:1** |
| Danger (`Out of service`, `Delete`) | cab | `#e8503f` | `#0b0b0d` | **5.29:1** | **5.29:1** |
| Danger | day | `#a8180c` | `#ffffff` | **7.50:1** | **7.50:1** |
| Warning (`Report defect`) | cab | `#ffc247` | `#0b0b0d` | **12.23:1** | **12.23:1** |
| Secondary (outline) | cab | transparent | `#d6d8dd` 13.79:1 | — | border `#9aa0aa` **7.48:1** |
| Secondary (outline) | day | transparent | `#101114` 18.88:1 | — | border `#4d525b` **7.85:1** |

**Disabled controls:** `cab` label `#7c828d` on `#1f2126` = **4.17:1**; `day` label `#6b7078` on `#eceef1` = **4.29:1**. Both clear 4.5:1 for large/label sizes and clear 3:1 non-text. Disabled state is additionally carried by `aria-disabled="true"` + a "(unavailable)" suffix in the accessible name + reduced fill — never by colour alone. **Disabled controls remain focusable** (`aria-disabled`, not the `disabled` attribute) on every screen except native alert screens, so a screen-reader user can discover why an action is unavailable; the reason is on `aria-describedby`.

**Skeletons:** `cab` `#2a2d33` on bg = 1.42:1, `day` `#e4e6ea` on bg = 1.25:1. Skeletons are decorative, `aria-hidden="true"`, and carry no information — the information is in the live-region busy announcement (§1.7).

**Charts (W2, W8, W12, W13 analytics):** adjacent categorical fills contrast at only ~1.1:1 (e.g. cab `#7cc4ff` vs `#ffc247` = 1.17:1). Series are therefore **never distinguished by hue alone**: each series carries (a) a distinct fill pattern — solid / 45° hatch / dot / horizontal rule, (b) a direct in-place label or end-of-series label, and (c) a 2px `color.bg` separator stroke between adjacent fills, so the *measured* adjacency is fill-vs-separator (cab `#7cc4ff` vs `#0b0b0d` = 10.48:1; `#ffc247` vs `#0b0b0d` = 12.23:1) rather than fill-vs-fill. Every chart has a `Show as table` toggle rendering the identical data as a real `<table>` with `<caption>` and `<th scope>`; the toggle is the screen-reader path and is in the tab order, not hidden behind a menu.

### 1.3 Focus indicator

One indicator, both palettes, every control, both surfaces. Never removed, never replaced by a colour change alone.

- **Composite two-tone ring:** 2px gap ring in `color.focus.gap` (the page background) immediately outside the control, then 3px ring in `color.focus` outside that. Total 5px, drawn with `outline` + `outline-offset` so it is never clipped by `overflow`.
- Measured contrast: `cab` ring `#ffd166` vs page `#0b0b0d` = **13.64:1**; gap `#0b0b0d` vs primary button `#35a862` = **6.49:1**, vs danger button `#e8503f` = **5.29:1**. `day` ring `#101114` vs page `#ffffff` = **18.88:1**; gap `#ffffff` vs primary `#0f6c34` = **6.53:1**. Every combination clears 3:1 on both sides of the ring, so the ring is visible against any approved fill.
- `:focus-visible` governs the ring for pointer users; **keyboard focus always shows the ring**, and programmatically-moved focus (§1.6) always shows it — use a `focus-ring-visible` class forced on when focus is set by script, because `:focus-visible` is unreliable after `.focus()` on a container.
- Containers that receive programmatic focus (`tabindex="-1"` headings, error summaries, dialogs) show the same ring. A "focus moved here" ring is required, not optional — silent focus movement is a defect.
- Native: same 5px composite drawn as a `borderWidth`/`shadow` pair on the focused element; on iOS the VoiceOver cursor is additionally honoured, on Android `android:focusable` + the same visual ring for keyboard/switch-access users.
- **200% zoom and 400% reflow:** the ring never causes clipping; all layouts reflow to a single column at 320 CSS px equivalent with no horizontal scroll (§1.11).

### 1.4 Landmark and heading model

**No MFE topology exists** (PRD §8, both CLAUDE.md files) — `sdlc:mfe-architecture`'s shell/remote heading split does **not** apply. Each surface is one application and owns its own `<h1>`.

**Web landmark skeleton, present on every route:**

```
<a class="skip-link" href="#main">Skip to main content</a>     ← first tab stop, visible on focus
<header role="banner">                                          ← dept name, palette switch, active-call bar
  <nav aria-label="Primary">…</nav>
</header>
<main id="main" tabindex="-1">                                  ← exactly one per page
  <h1>{route title}</h1>
  …
</main>
<aside role="complementary" aria-label="Active call">           ← only when a call is active
<footer role="contentinfo">
<div id="polite-live"  aria-live="polite"  aria-atomic="true">   ← §1.5
<div id="alert-live"   role="alert">
<div id="status-live"  role="status">
```

- Exactly one `<h1>` per route, matching the document `<title>` (`{route title} — Boxalarm`). `document.title` is updated on every route change *before* focus moves (§1.6).
- Heading levels never skip. Card titles inside an `h2` section are `h3`; a table's caption is not a heading.
- Every landmark that appears more than once on a page carries a distinguishing `aria-label` (e.g. two `<nav>`: `aria-label="Primary"` and `aria-label="Incident sections"`).
- Data tables use real `<table>` with `<caption>`, `<th scope="col">` / `<th scope="row">`; sortable headers use `aria-sort` on the sorted column only.
- **Skip links:** `Skip to main content` on every route; routes with a persistent left rail (W5–W15) add `Skip to filters`. The active-call bar, when present, gets `Skip to active call` as the **first** skip link — it outranks main content.

**Native accessibility container model** (React Native has no landmarks; these are the equivalents and are binding):

- Every screen's root is `accessibilityRole="none"` with an `accessibilityLabel` naming the screen; the first element is a `Text` with `accessibilityRole="header"` (the `h1` equivalent). Exactly one per screen.
- Section titles use `accessibilityRole="header"` too; RN exposes no level, so **hierarchy is carried by reading order and by prefixing section headers with their section name in the accessible label** (e.g. `accessibilityLabel="Section: Riding assignments"`).
- Tab bar: `accessibilityRole="tablist"` on the container, `"tab"` on each item, `accessibilitySelected` on the active one.
- Modals: `accessibilityViewIsModal={true}` on iOS and `importantForAccessibility="no-hide-descendants"` on every sibling for Android. Both are required; one alone leaks the background to a screen reader.
- Screen headers use `accessibilityRole="header"`, and back buttons are labelled `Back to {previous screen}`, never "Back".

### 1.5 Live-region architecture

Three regions on web, mounted once in the shell, **present in the DOM from first paint** (a region injected at announcement time is not reliably announced):

| Region | Markup | Politeness | Carries |
|---|---|---|---|
| `#status-live` | `role="status"` (`aria-live="polite"`) | polite | Loading/busy, save confirmations, background sync completion, queue drain, filter results count |
| `#polite-live` | `aria-live="polite" aria-atomic="true"` | polite | Route-change announcements, list-count changes, non-blocking partial-data notices |
| `#alert-live` | `role="alert"` (`aria-live="assertive"`) | **assertive** | New dispatch, alert-path failure, submission failure, connectivity loss on a submitting action, out-of-service declaration |

**Assertive is rationed.** Only five classes of event may use it, and they are the only ones in this document marked *assertive*: (1) a new dispatch arriving, (2) an escalation-ladder failure the user must act on, (3) a destructive action completing irreversibly, (4) losing the network *during* a submit, (5) a NERIS submission failing. Everything else is polite. A member may be driving; an assertive interrupt on a non-urgent event trains people to ignore the one that matters.

Rules binding on every announcement in §4/§5:
- Clear the region (`textContent = ''`) then set text on the next animation frame; identical consecutive strings get a trailing zero-width space so repeated events re-announce.
- Never both move focus and announce for the same event — the focus move already announces the destination. Where a screen does both, the announcement is the *outcome* and focus lands on the *object*, and the announcement fires 150ms after focus settles.
- Announcements are full sentences with no concatenation (i18n readiness), interpolated by name.
- Loading announcements are debounced 400ms: an operation that resolves faster than 400ms announces only its result, never "Loading".

**Native equivalents:**
- Polite: Android `accessibilityLiveRegion="polite"` on the status container; iOS `AccessibilityInfo.announceForAccessibility(text)`.
- Assertive/interrupting: `AccessibilityInfo.announceForAccessibilityWithOptions(text, { queue: false })` — `queue: false` is what makes it interrupt on iOS; Android uses `accessibilityLiveRegion="assertive"`. Both must be issued; RN does not unify them.
- **Screen-reader announcement must never be the only channel on the alert path.** Every alert announcement is accompanied by the critical-alert sound (F1.9), device haptics (a distinct 3-pulse pattern), and persistent on-screen text. A member driving with the phone in a mount, a member with the phone in a turnout pocket, and a deaf member each get a channel that reaches them.

### 1.6 Keyboard and focus choreography — global

**Web global keyboard model:**

| Key | Behaviour | Scope |
|---|---|---|
| `Tab` / `Shift+Tab` | DOM-order traversal. DOM order matches visual order on every screen; no positive `tabindex` anywhere. | Global |
| `Enter` | Activate link, submit form, activate button | Global |
| `Space` | Activate button, toggle checkbox/switch, page down when not on a control | Global |
| `Escape` | Close the topmost layer: menu → popover → drawer → dialog. Never navigates back, never discards typed input without a confirm. | Global |
| `Arrow` keys | Move within a composite: tabs, radio group, menu, listbox, table grid, calendar. The composite is one tab stop (roving `tabindex`). | Composites |
| `Home` / `End` | First / last item within a composite | Composites |
| `/` | Focus the page's primary search input, when the screen has one and focus is not already in a text field | W3, W5, W9, W11, W13 |
| `g` then `a` | Go to the active call, when one exists | Global, web |
| `?` | Open the keyboard-shortcut sheet | Global, web |

Shortcuts are single-key and therefore fall under **2.1.4 Character Key Shortcuts**: all of `/`, `g a`, `?` are (a) suppressed while focus is in any text input, textarea, or `contenteditable`, and (b) individually disableable in `/admin` → Accessibility, which also exposes a global "Disable single-key shortcuts" switch. Nothing in this product depends on a shortcut; every shortcut duplicates a visible control.

**Focus-move rules — the complete list of transitions that move or destroy focus.** Every transition below has a named destination. Anything not on this list does not move focus.

| Transition | Focus destination |
|---|---|
| Route change (web) | `<main id="main" tabindex="-1">` receives `.focus()` after `document.title` is set; `#polite-live` announces `"{route title}. {n} items."` Focus is **not** put on the `h1` — `main` includes the heading in its reading. |
| Route change with a deep-link anchor | The anchored element (`tabindex="-1"`), not `main`. |
| Dialog / drawer / bottom sheet opens | The dialog's own `h2`, `tabindex="-1"`, unless the dialog has exactly one obvious action, in which case the first interactive control. Focus is trapped (§below). |
| Dialog closes (any reason: `Escape`, close button, backdrop, confirm, cancel) | The element that opened it. If that element no longer exists (it was the deleted row), focus goes to the **next sibling row**; if none, the **previous sibling**; if the list is now empty, the list's empty-state action button. |
| Menu / popover opens | First menu item. |
| Menu closes | The trigger button. |
| Async completion — foreground (user is waiting) | Focus does **not** move. `#status-live` announces the outcome. |
| Async completion — background (user has moved on) | Focus does **not** move. `#status-live` announces politely; the affected region gets a visible "Updated" marker that is also in the announcement. |
| Validation failure on submit | The **error summary** container (`tabindex="-1"`, `role="alert"`), placed immediately after the `h1` and before the form. From there `Tab` reaches the first error link; activating it moves focus to that field. Focus does **not** jump straight to the first field — the user must hear how many errors there are first. |
| Single-field async validation failure (blur) | Focus does not move; the field gets `aria-invalid="true"` and the message is wired to `aria-describedby`; nothing is announced on blur (the user has already left). |
| Content inserted above the viewport (new dispatch row, new roster entry) | Focus does **not** move. Polite announcement + a "{n} new" button pinned at the top of the list; activating it scrolls and focuses the first new row. |
| Focused element is deleted | Next sibling → previous sibling → the list container's first remaining control → the empty-state action. Never `<body>`. |
| Focused element becomes disabled | It stays focused; `aria-disabled="true"` is set and the reason is announced politely. Focus is never destroyed by disablement. |
| Filter / search changes the list | Focus stays in the input; `#status-live` announces `"{n} results."` debounced 500ms. |
| Expand / collapse a disclosure | Focus stays on the trigger; `aria-expanded` flips. |
| Pagination / "load more" | Focus moves to the first newly-loaded row (`tabindex="-1"`), announced as `"{n} more loaded."` |
| Wizard step change (W14, N9) | The new step's `h2`, `tabindex="-1"`; polite announcement `"Step {n} of {total}. {step name}."` |
| Sign-in success (W1, N14) | Full route change to the destination; `main` focused. **This is the only authentication focus transition in the product.** |
| Sign-out (explicit, user-initiated only) | `/signin` heading. There is no automatic sign-out. |

**Focus trap boundaries:** dialogs, drawers, bottom sheets, and the native full-screen alert screen (N1). Inside a trap: `Tab` from the last control wraps to the first; `Shift+Tab` from the first wraps to the last; the trap contains a close affordance reachable in ≤ 3 tab stops; `Escape` exits (except N1 — see §5, N1); everything outside is `aria-hidden="true"` (web) / `accessibilityViewIsModal` + `importantForAccessibility="no-hide-descendants"` (native). A trap is never nested more than two deep; opening a third layer closes the second.

**Every hover-only, drag-only, or pointer-only interaction and its keyboard equivalent** (this is the complete inventory; no other pointer-only interaction is approved):

| Interaction | Where | Keyboard / assistive equivalent |
|---|---|---|
| Hover tooltip on a status chip | W3, W4, W5, W11, W13 | The same text is a permanently-visible `aria-describedby` string; the chip is focusable and the tooltip shows on focus and stays until `Escape` or blur. |
| Hover row-actions reveal | W5, W7, W9, W11, W13 | Row actions are **always in the DOM and always focusable**; hover only changes their opacity, never their existence. Opacity floor is 1.0 when focused. |
| Drag to reorder riding assignments | W4, N3 | Each row has a `Move up` / `Move down` button pair (44px), plus `Alt+↑` / `Alt+↓` while the row is focused; each move announces `"{name} moved to position {n} of {total}."` politely. |
| Drag a member onto an apparatus | W4 | `Assign to…` button on the member row opens a listbox of apparatus; selecting assigns. |
| Drag to reorder a checklist in config | W15 | Same `Move up`/`Move down` + `Alt+↑`/`Alt+↓` pattern. |
| Swipe a shift card to claim | N6 | The card's primary button `Claim shift` does the same thing; swipe is an accelerator only. `accessibilityActions` exposes `claim` as a custom action to VoiceOver/TalkBack rotors. |
| Swipe to dismiss a queued-sync banner | N5, N9 | `Dismiss` button, 44px, in the banner. |
| Pinch-zoom the map on the alert | N2, W4 | `+` / `−` buttons (56px on native) and `Open in maps` which hands off to the OS map app. The map is `accessibilityElementsHidden` with a text equivalent adjacent: full address, cross streets, and the pre-plan link (F1.8) as real text. |
| Long-press a roster row for the context menu | N3 | A visible `⋯ More` button (56px) on every row, opening the same menu. `accessibilityActions` also exposes each menu item as a custom action. |
| Slide-to-confirm out-of-service | W12, N8 | Replaced by a two-step button + confirm dialog. **A slider is not an approved confirmation affordance in this product** (2.5.1 Pointer Gestures / 2.5.7 Dragging Movements). |
| Signature capture on a defect report | N10 | Not in v1. If added, a typed-name alternative is mandatory. |
| Pull-to-refresh | N3, N5, N6, N8 | A `Refresh` button in the screen header, 56px, always present. Pull-to-refresh is an accelerator only. |

**Native keyboard/switch model:** every native screen is fully operable with an external keyboard (a real case — officers use tablets with keyboard cases) and with Switch Control / Switch Access. Focus order is declared with `accessibilityViewIsModal`, explicit `accessible={true}` grouping, and — where RN's default order is wrong — `accessibilityElementsHidden` on decorative wrappers. No native screen depends on a gesture that lacks a button equivalent in the table above.

### 1.7 Seven-state global patterns

Each state has one pattern; §4/§5 specify the per-screen instance (string, focus target, politeness). These are obligations, not suggestions.

**Loading.** Skeletons matching the final layout — never a bare full-page spinner (Moonaan standard). The skeleton container carries `aria-busy="true"`; the skeleton shapes are `aria-hidden="true"`. `#status-live` announces `"Loading {thing}."` after a 400ms debounce and `"{thing} loaded. {n} items."` on resolve. Focus does not move. Any control that was focusable before loading remains focusable during it. A load exceeding 10s adds a `Stop loading` button.

**Empty.** Heading + one sentence of *why* it is empty + exactly one primary action that fills it, which is a real focusable button, reachable by `Tab` and by the screen reader in reading order. Never a bare "No results". Announced politely as the sentence plus `"{action label}"`. When emptiness is caused by a filter, the empty state names the filter and offers `Clear filters` as the action.

**Error.** `role="alert"` region as the first child of `main` after the `h1`, focused (`tabindex="-1"`). Message = what happened + what to do next, and **must distinguish "we can't reach the server" from "the server rejected this"** (discovery Round 5) — those demand different actions at 03:00. A `Retry` button is always present and is the second tab stop after the message. In-progress user input is never cleared, never on any screen. Error codes go in a `<details>` labelled `Technical details`, collapsed, never as the primary message.

**Partial / degraded.** What loaded is rendered normally. What failed is rendered as an inline placeholder card carrying: a warning glyph, the text `"{Section} couldn't load."`, and a `Retry {section}` button — all three, so the failure is not colour-coded alone. Announced **once, politely**, as `"{n} sections couldn't load. The rest of the page is available."` Failed sections are also listed in the error summary if a form is present. Partial is never silently rendered as empty.

**Offline.** A persistent banner directly below the header (web) / below the screen header (native), `role="status"`, carrying: a slashed-cloud glyph, `"You're offline."`, and — mandatory — the three-part answer: what still works, what is queued, what is unavailable. Every control that cannot work offline gets `aria-disabled="true"` and `aria-describedby` pointing at `"Unavailable while offline."`; **controls are never removed from the DOM when offline** — a disappearing button is unexplainable to a screen-reader user. Actions that *can* be queued keep working and announce `"Saved on this device. It will sync when you're back online."` On reconnect: `#status-live` announces `"Back online. {n} items synced."` politely (assertive only if a sync *failed*).

**No permission.** Never a blank screen, never a 403 dump. A `role="region"` panel with `h2` `"You don't have access to this"`, a sentence naming *what* is restricted and *which role* holds it, and the name/contact route for who grants it (the chief, or `/admin` → Roles for those who hold it). Because authorization is role-based alone with no step-up (F9.1), the denied panel is the **only** visible authorization boundary in the product and must be treated as a first-class screen, not a fallback. It is announced politely on route entry as the heading plus the sentence. Navigation items the user cannot use are **rendered with `aria-disabled="true"` and a describedby reason, not hidden** — hidden items make a role's boundary invisible and cause repeat attempts.

**Default.** The populated nominal case, specified per screen in §4/§5.

### 1.8 Status encoding — the non-colour channel

Every status token in the product. Hue + glyph + border style + text, all four, always. Icons are decorative (`aria-hidden`) because the text carries the meaning; the accessible name is the text.

| Status | Glyph | Border | Text | cab hue | day hue |
|---|---|---|---|---|---|
| Responding | ✔ filled check | solid 1px | `Responding` | `#5ddb8a` | `#0f6c34` |
| Responding direct to scene | ➜ arrow | solid 1px | `Direct to scene` | `#5ddb8a` | `#0f6c34` |
| Not responding | ✕ cross | solid 1px | `Not responding` | `#ff6b5e` | `#c02418` |
| No response yet | ○ hollow circle | dashed 1px | `No response yet` | `#a3a8b2` | `#4d525b` |
| Marked off / unavailable | ⊘ slashed circle | 45° hatch fill | `Marked off` | `#a3a8b2` | `#4d525b` |
| In service | ▣ filled square | solid 1px | `In service` | `#5ddb8a` | `#0f6c34` |
| Out of service | ▲ triangle | 45° hatch fill | `Out of service` | `#ff6b5e` | `#c02418` |
| Due soon (cert, test) | ◔ quarter circle | solid 1px | `Due in {n} days` | `#ffc247` | `#6f4c00` |
| Expired / overdue | ▲ triangle | double 3px | `Expired {date}` | `#ff6b5e` | `#c02418` |
| Delivered | ✔ check | solid 1px | `Delivered {time}` | `#5ddb8a` | `#0f6c34` |
| Sent, not delivered | ◑ half circle | dashed 1px | `Sent, not delivered` | `#ffc247` | `#6f4c00` |
| Delivery failed | ▲ triangle | double 3px | `Not delivered` | `#ff6b5e` | `#c02418` |
| Opened | ◉ filled ring | solid 1px | `Opened {time}` | `#7cc4ff` | `#0b57d0` |
| Escalated to SMS / voice | ⇈ double arrow | solid 2px | `Escalated to {channel}` | `#ff9b3d` | `#8a4a00` |
| Queued offline | ☁̸ slashed cloud | dashed 1px | `Queued — not yet synced` | `#ffc247` | `#6f4c00` |
| Synced | ✔ check | solid 1px | `Synced {time}` | `#5ddb8a` | `#0f6c34` |
| Submitted to NERIS | ✔ check | solid 1px | `Submitted {date}` | `#5ddb8a` | `#0f6c34` |
| NERIS rejected | ▲ triangle | double 3px | `Rejected — needs fixing` | `#ff6b5e` | `#c02418` |
| Draft | ◻ hollow square | dashed 1px | `Draft` | `#a3a8b2` | `#4d525b` |

Hatch and double-border patterns are also what carries status in a forced-colours / high-contrast context, where hue is discarded entirely: every screen must be re-read in `forced-colors: active` and must lose no information. `forced-colors` overrides are specified once — status glyph and text remain, fills become system colours, and the focus ring becomes `Highlight`.

### 1.9 Motion inventory and reduced-motion alternatives

Complete inventory. Every animation in the design appears here with its `prefers-reduced-motion: reduce` behaviour (web) / `AccessibilityInfo.isReduceMotionEnabled()` behaviour (native). **Reading the OS setting is mandatory on both surfaces**; on native it must also be re-read via the `reduceMotionChanged` subscription, not just at mount.

| # | Animation | Where | Duration | Carries meaning? | Reduced-motion alternative |
|---|---|---|---|---|---|
| 1 | Incoming-alert full-screen entrance (slide up + scale) | N1 | 350ms | Yes — signals arrival | **Not removed.** Cross-fade at 120ms, no transform. Arrival is additionally carried by the critical-alert sound, the 3-pulse haptic, and the persistent banner text — the alert is perceivable with motion fully disabled and with the screen not being watched. |
| 2 | Alert-banner pulse (attention loop on the active-call bar) | Web all routes, N5 | 1.2s loop | Yes — "still active" | **Replaced, not removed:** a static high-contrast bar with the text `Active call — {type} at {address}` and a live-updating elapsed timer that increments as text. No looping animation. A loop exceeding 5s would also need a pause control (2.2.2), which the static replacement avoids entirely. |
| 3 | Response-button confirm (press → fill sweep → check) | N2 | 250ms | Yes — confirms the tap registered | Instant state swap to the confirmed style + haptic tick + polite announcement `"Responding. The officer has been told."` The confirmation must never be motion-only. |
| 4 | Roster row insert (slide + highlight fade) | W4, N3 | 250ms | Yes — "this is new" | Row appears with a persistent `New` chip that remains for 30s, no movement. Polite announcement `"{name} is responding."` |
| 5 | Route transition (fade) | Web | 150ms | No | Removed. |
| 6 | Drawer / bottom-sheet slide-in | Web, native | 250ms | Yes — spatial origin | Cross-fade 100ms, no transform. Focus behaviour unchanged. |
| 7 | Skeleton shimmer | All loading states | 1.5s loop | No | Static skeleton block at `color.skeleton`, no shimmer. |
| 8 | Progress bar fill (truck-check progress, upload) | N9, N10, W14 | continuous | Yes — progress | Retained as a **stepped** bar that jumps per completed item, plus the text `"{n} of {total} checked"` which is the authoritative channel. `aria-valuenow` updates regardless of motion setting. |
| 9 | Toast enter/exit | Web | 250ms | No | Instant appear/disappear. Toasts are never the only channel — every toast duplicates a live-region announcement. |
| 10 | Chart series draw-in | W2, W8 | 400ms | No | Rendered at final state immediately. |
| 11 | Sync spinner on the queued-item badge | N5, N9 | 1s loop | Yes — "working now" | Static `Syncing…` text + a stepped `{n} of {total}` counter. |
| 12 | Expand/collapse height animation | W6, W12, W14, N9 | 200ms | Yes — origin of new content | Instant show/hide. `aria-expanded` is the authoritative channel either way. |
| 13 | Map pin drop | N2, W4 | 300ms | No | Pin rendered in place. |
| 14 | Palette switch (cab ↔ day) cross-fade | All | 150ms | No | Instant swap. |
| 15 | Escalation-ladder step advance (channel row highlight) | W4 | 250ms | Yes — a channel just changed | Instant style change + a `Just changed` chip on the row for 10s + polite announcement `"{name}: escalated to {channel}."` |

Global rules: nothing animates on a blocking path — the user can act before any animation completes, on every screen. No animation exceeds 400ms. Nothing flashes more than 3 times per second anywhere (2.3.1); the incoming-alert screen in particular uses a **steady** high-contrast treatment, never a strobe — a strobing alert screen is a seizure risk aimed at exactly the population that must look at it. No parallax, no auto-playing video, no auto-advancing carousel anywhere in the product.

### 1.10 Forms and errors — global wiring

Binding on every form on both surfaces.

- **Label:** every input has a persistent visible `<label for>` (web) / `accessibilityLabel` on a labelled `TextInput` (native). Placeholders are never labels and are never the only hint. Placeholder contrast is specified in §1.2 and clears 4.5:1 — placeholders carry examples, never instructions.
- **Describedby:** helper text and error text are both in `aria-describedby`, in that order: `aria-describedby="{id}-help {id}-error"`. The error node exists in the DOM always and is empty when valid — swapping the id in and out loses the association in some screen readers.
- **Invalid:** `aria-invalid="true"` set on the field at the moment its error text is populated, removed the moment it validates. `aria-required="true"` on required fields; when most fields are required, the *optional* ones are marked `(optional)` in the visible label text, not the required ones — consistently within a form.
- **Validation timing:** on blur, never on keystroke. After a field has errored once, it re-validates on change so the user sees it clear.
- **Error summary:** required on every form over five fields (W1 is under; W6, W14, W15, N10, N15 are over). Rendered as `role="alert"` + `tabindex="-1"`, placed immediately after the `h1`, containing `"{n} problems to fix before you can {action}."` and an ordered list of links, each link's text being the field label plus the problem. Activating a link focuses that field. Focus moves to the summary on failed submit (§1.6).
- **Never clear input.** On validation failure, on submission failure, on network loss, on navigating away and back within the session, and on refresh: typed content survives. Multi-step forms (W14, N9, N10) persist per-step to local storage keyed by record id and restore on return, announcing `"Restored your unsaved changes from {time}."` politely.
- **Destructive actions:** prefer undo. Reversible actions (remove a member from a shift, un-assign a riding position, delete a draft) execute immediately and show a 10-second undo affordance that is a real focusable button in `#status-live`'s adjacent region, announced politely with the undo available. Irreversible actions (place an apparatus out of service, submit to NERIS, export the department dataset, delete a member record) require a confirm dialog naming the specific object and the specific consequence — `"Place Engine 1 out of service? It will be removed from riding assignments and from the alert roster until you return it to service."` — with the destructive button being the *non*-default focus target (focus lands on the dialog heading, per §1.6).
- **No re-authentication anywhere.** Export (F9.5) and destructive admin actions are confirm-dialog-gated only. No password field, no code entry, no biometric prompt appears in any confirm dialog in this product.
- **Submit buttons** name their outcome (`Mark responding`, `Submit to NERIS`, `Save check`), never `Submit`/`OK`. While submitting: `aria-busy="true"` on the form, button label changes to `"{Verb}ing…"`, button stays focused and focusable (never disabled — a disabled button loses focus and strands screen-reader users), and re-activation is idempotent.

### 1.11 Target sizes, spacing, zoom, and text scaling

- **Field posture (native, and web routes W3/W4 when used on a phone):** minimum interactive target **56 × 56** (`target.field`), 12px minimum separation. This exceeds the 44px AA floor deliberately — N3.5 gloves.
- **Alert path (N1, N2, and the response buttons wherever they appear):** minimum **72 × 72** (`target.alert`), 16px separation, and the primary `Responding` button spans the full content width at 88px tall. A mis-tap at 03:00 in gloves is a staffing failure.
- **Office posture (web W1–W15 on desktop):** minimum **44 × 44** with 8px separation. Dense tables (W5, W8, W9, W13) use 44px row height with the row action buttons at 44 × 44 — **the row does not shrink below this even in `compact` density.** Density modes are declared per screen in §4 and never mixed within a screen.
- **Flagged where the layout fights the size:** (a) W13 incident table with 9 columns at `md` cannot hold 44px actions plus 9 columns — resolved by collapsing to a card list below `lg`, not by shrinking targets; (b) W4's per-member × per-channel receipt grid at 3 channels × 40 members — resolved by making each cell a non-interactive status chip with one 44px `Details` button per row, rather than 120 tiny interactive cells; (c) N9's checklist with 40 items — resolved by 56px rows with the pass/fail control being a 56px segmented pair, one item per row, never a grid.
- **Zoom and reflow:** every web route survives 200% browser zoom and 400% reflow (320 CSS px equivalent) with no horizontal scroll and no clipped content. Wide content — the W4 receipt grid, W13 incident table, W12 test schedule — scrolls inside its own `overflow-x: auto` container with `tabindex="0"`, `role="region"`, and an `aria-label` naming it, so the scroll region is keyboard-reachable (a scrollable region that is not focusable is a keyboard trap in reverse).
- **Text scaling:** native honours the OS Dynamic Type / font-scale setting up to 200% with no clipping and no truncation of any status text; `allowFontScaling` is never set to `false` anywhere, including the 32px alert address. Web uses `rem` throughout so browser font-size settings apply. Layouts tolerate +40% string expansion (i18n readiness) — status chips wrap to two lines rather than truncate, and no status text is ever truncated with an ellipsis, on any screen.
- **Orientation:** no screen locks orientation (1.3.4). The native alert screen (N1) works in landscape — a phone in a dash mount is often landscape.
- **Touch and hold:** no interaction requires a press longer than 500ms without an alternative (§1.6 table). No interaction requires multi-point input anywhere.

---
## 2. Screen inventory

Derived from the discovery brief Round 4 (~15 web routes, ~15 native screens across 5 stacks) and the PRD functional requirements. This is the authoritative inventory this specification covers.

**Web — `apps/web`, 15 routes (office posture, `day` palette default, `cab` selectable):**

| ID | Route | Screen | Primary roles |
|---|---|---|---|
| W1 | `/signin` | Sign in | All |
| W2 | `/` | Dashboard (role-adaptive) | All |
| W3 | `/alerts` | Dispatch log | Officer, chief, admin |
| W4 | `/alerts/:id` | Alert detail — receipts, roster, riding assignments | Officer, chief |
| W5 | `/roster` | Member roster | Officer, chief, admin |
| W6 | `/roster/:id` | Member detail — quals, certs, LOSAP, attendance | Officer, chief, admin, self |
| W7 | `/shifts` | Duty shifts & coverage | Officer, chief, member |
| W8 | `/attendance` | Attendance & LOSAP points | Admin, chief |
| W9 | `/training` | Certifications & expiry | Training officer, chief |
| W10 | `/training/drills` | Drills & training events | Training officer, chief, member |
| W11 | `/apparatus` | Apparatus registry & out-of-service | Apparatus officer, chief |
| W12 | `/apparatus/:id` | Apparatus detail — checks, SCBA, testing, defects | Apparatus officer, chief |
| W13 | `/incidents` | Incident list & NERIS submission status | Officer, chief |
| W14 | `/incidents/:id` | NERIS incident report editor | Officer, chief |
| W15 | `/admin` | Department configuration & data export | Chief, admin |

**Native — `apps/mobile`, 5 stacks / 15 screens (field posture, `cab` palette default, `day` selectable, auto-switch by ambient light offered but never automatic without a manual override):**

| ID | Stack | Screen |
|---|---|---|
| N1 | Alert | Incoming alert (full-screen, wakes device) |
| N2 | Alert | Alert detail & respond |
| N3 | Alert | Live response roster |
| N4 | Alert | Alert-path self-test (F1.10) |
| N5 | Duty | Home — my status & availability |
| N6 | Duty | Open shifts |
| N7 | Duty | Shift detail & claim |
| N8 | Apparatus | Apparatus list |
| N9 | Apparatus | Truck check run |
| N10 | Apparatus | Defect report with photo |
| N11 | Records | My profile & contact |
| N12 | Records | My certifications |
| N13 | Records | My LOSAP points & attendance |
| N14 | System | Sign in |
| N15 | System | Notifications & alert-path settings |

---

## 3. Cross-cutting flow choreography

Four flows cross screen boundaries. Their transitions are specified here once; the per-screen sections reference them.

### 3.1 Alert → respond → roster (the flagship)

This flow's accessibility is the product. It is specified as an ordered sequence of events with the announcement, the focus destination, and the non-visual channel for each.

| # | Event | Surface | Announcement | Politeness | Focus | Non-visual channel |
|---|---|---|---|---|---|---|
| 1 | Dispatch arrives, app backgrounded or device locked | N1 | OS critical-alert notification body, read in this order: **`"{incident type}. {street address}. {town}. Dispatched {time}."`** Cross streets and narrative are *not* in the notification body — they are on N1. | OS critical alert, pierces silent/DND (F1.9) | n/a | Critical-alert sound + 3-pulse haptic, both distinct from every other notification in the app |
| 2 | N1 opens (tap, or auto-present on lock screen) | N1 | `announceForAccessibilityWithOptions({queue:false})`: `"Incoming call. {incident type} at {street address}, {town}. Cross streets {a} and {b}. Are you responding?"` | **Assertive** — one of the five permitted assertive classes | The `h1` header text node (`accessibilityRole="header"`, focused via `setAccessibilityFocus`) so the address is read before the buttons | Sound + haptic continue until acknowledged or 60s |
| 3 | Reading order on N1 (screen-reader traversal) | N1 | Fixed and mandatory: (1) incident type, (2) street address, (3) town, (4) cross streets, (5) `Responding` button, (6) `Responding direct to scene` button, (7) `Not responding` button, (8) dispatch narrative, (9) `Pre-plan` link, (10) `Hydrants` link, (11) `Open in maps`, (12) elapsed timer. **The three response buttons come before the narrative** — a driving member must reach the answer without listening to the narrative first. | — | — | — |
| 4 | Member taps `Responding` | N2 | `"Responding. The officer has been told. {n} others responding."` | Polite | Stays on the button, which becomes the `Change response` control with an updated accessible name | Haptic tick; button state swap is instant even with reduced motion (§1.9 #3) |
| 5 | Response fails to send (no connectivity) | N2 | `"Couldn't reach the server. Your response is saved on this phone and will send automatically. Turn on cellular data or move to signal."` | **Assertive** — connectivity lost during a submit is a permitted assertive class | Stays on the button; the button's accessible name becomes `Responding — queued, not yet sent` | Distinct 2-pulse haptic; persistent queued chip (§1.8) |
| 6 | Response sends after queueing | N2/N5 | `"Your response has been sent. The officer can see you're coming."` | Polite | No move | Chip flips to `Synced {time}` |
| 7 | Officer opens the live roster | N3 / W4 | On load: `"Live roster. {n} responding, {m} direct to scene, {k} not responding, {j} no response yet."` | Polite | `main` (web) / screen header (native) | — |
| 8 | A member's response arrives while the roster is open | N3 / W4 | `"{name} is responding. {n} responding."` — rate-limited to one announcement per 3 seconds, coalescing into `"{n} more members responding. {total} responding."` when they arrive faster | Polite | **No focus move.** New row gets a `New` chip for 30s (§1.9 #4) | — |
| 9 | Escalation ladder advances for a member | W4 | `"{name}: no acknowledgement. Escalated to {channel}."` | Polite | No move | Row gains the `Escalated to {channel}` chip (§1.8) |
| 10 | The alert path itself fails (a channel is down, F1.3/N1.3) | W4, N5 | `"Alert delivery problem: {channel} is not delivering. {n} members have not been reached. Call them by radio."` | **Assertive** — permitted class (2) | Focus moves to the failure banner (`role="alert"`, `tabindex="-1"`) because this one requires action | Native: distinct haptic; the banner persists until dismissed by an officer |
| 11 | A second dispatch arrives during an active call | N1, all web routes | Native: N1 presents again for the new call, with the header text `"Second call. You are already responding to {first incident type}."` read first. Web: the active-call bar becomes two stacked bars, each with its own heading, and `#alert-live` announces `"Second call: {type} at {address}. You are still marked responding to the first call."` | **Assertive** | Native: header of the new N1. Web: the new bar's heading. | Sound + haptic; the two calls are never merged or collapsed |
| 12 | Member is marked off (unavailable) when the dispatch fires | N1 | N1 still presents. Header reads `"Incoming call. You are marked off until {date}. {incident type} at {address}. Respond anyway?"` The primary button's accessible name is `Respond anyway — you are marked off`. | Assertive | Header | Being marked off never suppresses the alert, only the expectation |

**Prohibited in this flow, on every screen it touches:** any sign-in prompt, any session-expiry notice, any re-authentication, any modal that must be dismissed before the response buttons are reachable, any interstitial permission request, and any announcement that says "Loading" before the address is available. If the address has not loaded, N1 shows the notification's address text (already delivered in the payload) — **the address is never in a loading state on N1.**

### 3.2 Truck check (90-second budget, offline, gloved)

| # | Event | Announcement | Politeness | Focus |
|---|---|---|---|---|
| 1 | Check starts | `"{Apparatus} check. {n} items. Item 1 of {n}: {item name}."` | Polite | First item's pass control |
| 2 | Item marked pass | `"{item} passed. Item {n+1} of {total}: {next item}."` | Polite | **Auto-advance to the next item's pass control.** This is the only auto-advance in the product and exists because of the 90-second budget; it is announced every time so it is never surprising, and a `Don't advance automatically` switch in N15 turns it off. |
| 3 | Item marked fail | `"{item} failed. Add a defect?"` | Polite | The `Add defect` button — no auto-advance on failure |
| 4 | Defect report opened (N10) | Modal; `"Report a defect on {item}, {apparatus}."` | — | Dialog `h1`; **check progress is preserved and re-announced on return** |
| 5 | Photo captured | `"Photo added. 1 of 3."` | Polite | Returns to the `Add photo` button |
| 6 | Defect saved, returning to the check | `"Defect saved. Back at item {n} of {total}: {item name}."` | Polite | The item that was failed, not the top of the list |
| 7 | Offline throughout | Banner (§1.7). Every save announces `"Saved on this device."` | Polite | No move |
| 8 | Check submitted online | `"Check complete. {n} passed, {m} failed. Sent to the apparatus officer."` | Polite | Confirmation screen header |
| 9 | Check submitted offline | `"Check complete and saved on this phone. {n} passed, {m} failed. It will send when you're back online."` | Polite | Confirmation screen header |
| 10 | Sync completes later, app foregrounded | `"Your {apparatus} check has been sent."` | Polite | No move |
| 11 | Sync fails permanently (server rejected) | `"Your {apparatus} check was rejected by the server and has not been recorded. Open it to fix and resend."` | **Assertive** — permitted class (5) | Notification opens N9 with the rejected check restored |

### 3.3 Incident report → NERIS submission

| # | Event | Announcement | Politeness | Focus |
|---|---|---|---|---|
| 1 | Report opened, pre-populated (F7.2) | `"Incident report for {type} at {address}. {n} of {total} fields already filled from the dispatch and the response roster. {m} still needed."` | Polite | `main`; the pre-filled fields are marked with a visible `From dispatch` chip and an `aria-describedby` reading `"Filled automatically from the dispatch. You can change it."` |
| 2 | Step change (wizard) | `"Step {n} of {total}. {step name}."` | Polite | Step `h2` |
| 3 | NERIS enumeration validation fails pre-submit (F7.3) | Error summary: `"{n} problems to fix before you can submit to NERIS."` | Polite (the summary is `role="alert"`, so it announces on insertion) | Error summary container |
| 4 | Submit succeeds | `"Submitted to NERIS. Incident {id}."` | Polite | Stays on the submit button, which becomes `Submitted — view receipt` |
| 5 | Submit fails, server unreachable | `"We couldn't reach NERIS. Your report is saved and will retry automatically. Nothing has been lost."` | **Assertive** — permitted class (5) | The failure banner |
| 6 | Submit fails, NERIS rejected the content | `"NERIS rejected this report: {reason}. Fix the {n} highlighted fields and submit again."` — and this string is explicitly different in wording and in the offered action from #5, per the discovery-brief requirement to distinguish *cannot reach* from *rejected* | **Assertive** | The error summary, which now lists the rejected fields as links |
| 7 | Rate-limited (HTTP 429, F7.6) | `"NERIS is busy. We'll keep retrying automatically. Next attempt in {n} seconds."` with the countdown in `#status-live` updated at most every 10 seconds | Polite | No move |

### 3.4 Open-shift claim (atomic, F2.9)

| # | Event | Announcement | Politeness | Focus |
|---|---|---|---|---|
| 1 | Shift list loads | `"Open shifts. {n} shifts, {m} you're qualified for."` | Polite | Screen header / `main` |
| 2 | Claim tapped | Button becomes `Claiming…`, `aria-busy` on the card | — | Stays on the button |
| 3 | Claim succeeds | `"You have {shift name}, {date} {start} to {end}. It's on your calendar."` | Polite | Stays on the button, now `Give back this shift` |
| 4 | Claim lost to another member (race) | `"{name} claimed this shift first. It's no longer open. {n} other shifts are still open."` | Polite | The card's `See other shifts` button — **the claim button is removed from the DOM only after focus has moved**, never while focused |
| 5 | Claim blocked by a missing qual | `"You can't claim this shift. It needs {qual} and your {qual} expired on {date}. Talk to the training officer."` | Polite | Stays on the (now `aria-disabled`) button, whose describedby carries the same reason |
| 6 | Claim attempted offline | `"You're offline. Shift claims can't be queued, because someone else may take it. Try again when you have signal."` — claiming is the one action in the product that is **not** queued offline, because atomicity cannot be preserved locally; this is stated in the offline banner on N6/N7 rather than left for the user to discover | **Assertive** — permitted class (4) | Stays on the button |

---
## 4. Web screens — `apps/web` (react-vite)

Every screen below inherits §1 in full. Density is declared per screen and never mixed. Default palette `day`; the palette switch in `role="banner"` is a 3-option radio group (`Day`, `Cab`, `Match my device`) with a visible legend, persisted per user, announced as `"Palette: {choice}."`

### W1 — `/signin` Sign in

**Landmarks & headings.** `banner` (department name only — no nav, the user is not authenticated), `main#main` with `h1` `Sign in to Boxalarm`, `contentinfo` with the support contact. No `complementary`. Skip link present but the page has one region; it targets `main`.

**Keyboard.** Tab order: skip link → email → password → `Show password` toggle → `Sign in` → `I forgot my password` → support phone link. `Enter` in either field submits. No `Escape` behaviour (no layers). No shortcuts on this route — `/`, `g a`, and `?` are all suppressed here.

**Focus.** On load: `main`. On submit failure: the error region (§1.7 Error), which is above the form. On success: full route change to the destination route, `main` focused (§1.6). `Show password` toggle keeps focus on itself, flips `aria-pressed`, and announces `"Password shown."` / `"Password hidden."` politely.

**Screen-reader narration.** Reading order: h1 → the one-sentence explainer `"You'll stay signed in. Boxalarm never signs you out."` → email → password → toggle → sign in → forgot. That explainer is mandatory content, not decoration: it is the user-facing statement of F9.1 and prevents members from expecting (and looking for) a session-expiry model that does not exist. Accessible names: `Show password` toggle is `aria-pressed` + `aria-label="Show password"`; the support link's name is `Call the department at {number}`, not the bare number.

**Form wiring.** Two fields, so no error summary (§1.10 threshold is five). Each field: visible label, `aria-describedby` to a permanently-present error node, `aria-invalid` on failure. Password field is `type="password"` with `autocomplete="current-password"`; email is `autocomplete="username"`. Credential recovery is one link, never a captcha, never a puzzle.

**Targets & density.** Comfortable. All controls 44 × 44 minimum; the `Sign in` button is full content width at 48px. Single column at every breakpoint; no reflow risk.

**Motion.** None on this route except #5 route transition (removed under reduced motion).

| State | Specification |
|---|---|
| **Default** | Two fields, one primary button, one recovery link, the "you'll stay signed in" explainer. |
| **Loading** | Only on submit. Button label → `Signing in…`, `aria-busy="true"` on the form, button stays focused and focusable. No skeleton (nothing to skeletonize). `#status-live`: nothing under 400ms; over 400ms, `"Signing in."` |
| **Empty** | **Cannot occur** — a sign-in form has no data to be empty of. Stated reason: the form is static content. |
| **Error** | Two distinct messages, never merged: credentials rejected → `"That email and password don't match. Check them and try again, or use 'I forgot my password'."`; server unreachable → `"We can't reach Boxalarm right now. Check your connection. If you're on a call, use radio — the department's tone-out paging is still running."` The second names the N1.9 fallback because a member unable to sign in at 03:00 needs the operational answer, not a retry loop. `role="alert"`, focused. **Typed email is never cleared.** |
| **Partial** | **Cannot occur** — the route loads no partial data; it is a single static form with one endpoint. |
| **Offline** | Banner: `"You're offline. You can't sign in until you have a connection. If you're already signed in on this phone, close this and open Boxalarm — you won't be asked again."` `Sign in` is `aria-disabled` with the reason on describedby, not removed. Announced politely on transition to offline; assertive if it happens mid-submit (permitted class 4). |
| **No permission** | **Cannot occur on entry** — sign-in is public. The adjacent case is a valid credential for a **deactivated member**: `h1` stays, the form is replaced by a `role="region"` panel `"Your membership is not active"` + `"Your account is marked {status}. The chief or an administrator can reactivate it. Call the department at {number}."` Announced politely, focused. Never a bare 403. |

### W2 — `/` Dashboard (role-adaptive)

**Landmarks & headings.** `banner` (dept name, palette switch, active-call bar when present, `nav aria-label="Primary"`), `main#main` with `h1` `Dashboard`, then `h2` per card region: `Active call` (only when live), `Staffing right now`, `Out of service`, `Certifications expiring`, `Recent incidents`, `NERIS compliance`. Each card's inner titles are `h3`. `complementary aria-label="Active call"` when a call is live. `contentinfo`.

**Role adaptation is additive, never subtractive in the accessibility tree:** a chief sees six regions, a member sees three. Regions a role cannot see are **absent**, not empty — but the primary nav still lists every route with the unavailable ones `aria-disabled` + reason (§1.7 No permission), so the boundary is visible.

**Keyboard.** Skip links: `Skip to active call` (when live, first), `Skip to main content`. Tab: banner controls → nav (single tab stop, arrow-key roving) → main → each card in DOM order → footer. Cards are not focusable containers; their contents are. `g a` jumps to the active call. `?` opens the shortcut sheet (dialog, trapped, `Escape` closes, focus returns to the invoker or to `main` when opened by keyboard from no control).

**Focus.** Route entry: `main`. Card refresh (auto every 30s): **no focus move**, polite `"Staffing updated. {n} available."` at most once per 60s. Chart `Show as table` toggle: focus stays on the toggle, `aria-expanded` flips, table announced politely as `"Table shown. {n} rows."` Active-call bar appearing mid-session: no focus move, `#alert-live` assertive per §3.1 #11.

**Screen-reader narration.** Each card's `h2` is followed immediately by its headline number as text before any chart: `"Staffing right now. 6 members available, 2 marked off."` The chart follows and is `aria-hidden` behind its table toggle equivalent (§1.2 Charts). Status counts are text, never inferred from a colour swatch.

**Targets & density.** Comfortable at `lg`+; card grid collapses to one column below `md`. All targets 44 × 44. Numbers use `type.h2`; no number smaller than `type.body`.

**Motion.** #2 alert-bar pulse (replaced by static bar + text timer), #10 chart draw-in (removed), #5 route fade (removed).

| State | Specification |
|---|---|
| **Default** | Six regions for a chief, three for a member. Every metric is text-first with the visual second. |
| **Loading** | Per-card skeletons in the final card shape; `aria-busy="true"` per card. `#status-live` after 400ms: `"Loading your dashboard."` On resolve: `"Dashboard loaded."` Cards resolve independently and each announces nothing individually — one summary announcement only, to avoid a six-announcement pile-up. |
| **Empty** | Per-card. `Out of service`: `"Nothing is out of service. Every apparatus is available."` — this is a *good* empty state and says so; no action button (nothing to do). `Recent incidents`: `"No incidents recorded yet. Incidents appear here after a call."` + `Go to incidents`. `Certifications expiring`: `"No certifications expire in the next 90 days."` + `See all certifications`. Every empty card states why and, where an action exists, offers exactly one. |
| **Error** | Whole-page failure only when the shell data fails: `role="alert"` + `Retry`, distinguishing unreachable from rejected (§1.7). Single-card failure is **partial**, not error — see below. |
| **Partial** | The dominant real state: 6 independent card queries. Loaded cards render. Failed cards render the inline placeholder (glyph + `"{Card name} couldn't load."` + `Retry {card name}`). One polite announcement: `"{n} of 6 dashboard sections couldn't load. The rest is available."` A failed `Active call` card is the exception — it escalates to assertive, because not knowing whether a call is active is not a degraded dashboard, it is an alerting failure. |
| **Offline** | Banner. Works: everything already loaded, plus cached last-known values, each stamped `"As of {time}"` in text next to the number — a stale number with no timestamp is worse than no number. Queued: nothing (the dashboard is read-only). Unavailable: `Retry` on cards, and every nav item that leads to a write action is `aria-disabled` with `"Unavailable while offline."` |
| **No permission** | A member reaching `/` sees the three member regions; no denied panel appears because the route itself is permitted. Attempting a chief-only card via deep link renders the §1.7 denied panel in place of that card with `h2` `"You don't have access to this"` + `"NERIS compliance is visible to the chief. Ask the chief for the chief role if you need it."` |

### W3 — `/alerts` Dispatch log

**Landmarks & headings.** `banner`, `main#main`, `h1` `Dispatch log`, `h2` `Filters` (a `<form role="search">` region), `h2` `Dispatches` over the table. `nav aria-label="Pagination"` below the table.

**Keyboard.** `/` focuses the search input (suppressed inside text fields). Filters: date range (two date inputs, native `type="date"`), incident type (listbox, arrow keys), delivery outcome (checkbox group). Table: a real `<table>` in a focusable `role="region" aria-label="Dispatches" tabindex="0"` scroll container. Column headers that sort are `<th><button>` with `aria-sort` on the active column only; `Enter`/`Space` sorts and announces `"Sorted by {column}, {ascending|descending}. {n} dispatches."` politely. Each row's first cell is `<th scope="row">` containing the link to W4.

**Focus.** Sort: stays on the header button. Filter change: stays in the control, debounced 500ms count announcement. Pagination: first row of the new page (`tabindex="-1"`), `"Page {n} of {m}. {k} dispatches."` New dispatch arriving while the log is open: no focus move; a `"1 new dispatch"` button pins to the top of the table region and is the mechanism to reach it (§1.6 content-insertion rule); the arrival itself is announced assertively per §3.1 #11 only when it is a live call the user is eligible for, politely otherwise.

**Screen-reader narration.** Row reading order: dispatch time → incident type → address → `{n} of {m} members reached` as text → delivery outcome chip text. Delivery outcome is never a bare icon. The table `<caption>` is `"Dispatches, newest first. {n} shown of {total}."` and updates with filters.

**Targets & density.** Compact density declared (office posture, data-dense) — **row height stays 44px**; compact reduces horizontal padding only. Below `lg` the table becomes a card list, one dispatch per card, each card 44px-target compliant.

**Motion.** #5 route fade (removed), #9 toast (instant).

| State | Specification |
|---|---|
| **Default** | Filter form + sortable table, newest first, delivery-outcome chip per row. |
| **Loading** | Table skeleton: 10 skeleton rows matching column widths, `aria-busy` on the table region, headers rendered for real (so the structure is announced immediately). `#status-live` after 400ms: `"Loading dispatches."` → `"{n} dispatches loaded."` |
| **Empty** | Two distinct empties. No dispatches at all: `"No dispatches yet. Dispatches appear here as soon as the department is toned out."` + `Run an alert self-test` (the one action that produces meaningful proof, F1.10). Filtered to nothing: `"No dispatches match these filters."` + `Clear filters` — the action names the filters in its describedby. |
| **Error** | `"We couldn't load the dispatch log."` (unreachable) vs `"The dispatch log request was rejected. Sign-in is fine — this is a server problem. Try again, and tell the chief if it keeps happening."` (rejected). `Retry` present. Filter selections survive. |
| **Partial** | The rows load but per-row delivery counts come from the alerting plane and can fail independently. Rows render; the count cell shows `"Delivery detail unavailable"` with the warning glyph and a `Retry` button in-cell (44px). Polite: `"Delivery detail couldn't load for {n} dispatches. The dispatch list is complete."` |
| **Offline** | Banner. Works: the last-loaded page, stamped `"As of {time}"` in the caption. Queued: nothing. Unavailable: filtering, sorting beyond the cached page, and pagination — each `aria-disabled` with `"Unavailable while offline."` |
| **No permission** | A plain member has no dispatch-log access. Denied panel: `"The dispatch log is for officers, the chief, and administrators. It shows who was reached on every call. Ask the chief if you need it."` Announced politely on entry, focused. The nav item remains visible and `aria-disabled` with the same reason. |

### W4 — `/alerts/:id` Alert detail — receipts, roster, riding assignments

The most accessibility-critical web screen: it is the officer's answer to "who is coming" and to "did the alert work" (F1.3, F1.7, N8.3).

**Landmarks & headings.** `banner`, `main#main`, `h1` `"{Incident type} — {address}"`, then `h2` `Call details`, `h2` `Response roster`, `h2` `Delivery receipts`, `h2` `Riding assignments`. `nav aria-label="Incident sections"` provides in-page jump links to those four `h2`s (each target `tabindex="-1"`). `complementary aria-label="Active call"` is suppressed on this route — the page *is* the call.

**Keyboard.** Section nav is a single tab stop with arrow keys. Roster: a table; each row has `Assign to…`, `Move up`, `Move down`, and `⋯ More`, all 44 × 44, all always in the DOM (§1.6). `Alt+↑` / `Alt+↓` reorder a riding assignment while the row is focused. Receipts grid: a `role="region" tabindex="0"` scroll container containing a real table, member rows × channel columns; the cells are **non-interactive status chips** and each row ends with one 44px `Details` button opening a dialog with that member's full per-channel timeline (§1.11 flagged case (b)).

**Focus.** Section jump: the target `h2`. `Assign to…`: opens a listbox dialog, focus to the dialog `h2`; on assign, dialog closes, focus returns to the `Assign to…` button, which now reads `"Assigned to {apparatus} — change"`; polite `"{name} assigned to {apparatus}."` Reorder: focus follows the moved row; announcement per §1.6 drag-equivalent rule. `Details` dialog: focus to dialog `h2`, `Escape` closes, focus returns to `Details`. A member row disappearing (member changed to `Not responding` and the view is filtered to responders): focus moves next-sibling → previous-sibling → the roster's `Filter` control (§1.6 deletion rule).

**Screen-reader narration.** On load, `#polite-live`: `"{Incident type} at {address}. {n} responding, {m} direct to scene, {k} not responding, {j} no response yet. {p} of {q} members reached."` Live updates per §3.1 #8 (rate-limited, coalescing) and #9 (escalation). Alert-path failure per §3.1 #10 is the only assertive announcement on this screen and it moves focus. Receipt cells' accessible names are full sentences: `"Push: delivered 03:04:12"`, `"SMS: sent, not delivered"`, `"Voice: not attempted"` — never `"✔"`.

**Targets & density.** Compact declared; 44px rows. The receipts grid is the flagged layout (§1.11 b). Below `lg`, receipts collapse to one card per member listing the three channels vertically.

**Motion.** #2 (static bar), #4 roster insert (New chip), #13 map pin (instant), #15 escalation highlight (instant + `Just changed` chip).

| State | Specification |
|---|---|
| **Default** | Call details, live roster with status chips, receipts grid, riding assignments. |
| **Loading** | Call details load first and render alone (they are the urgent part); roster and receipts show skeletons with `aria-busy`. `#status-live` after 400ms: `"Loading the response roster."` then `"{n} responding."` The `h1` address is never a skeleton — it comes from the route payload. |
| **Empty** | Roster with no responses yet: `"No one has responded yet. Members were alerted {n} seconds ago."` with a live-updating elapsed text and one action `Escalate now` (officer) — an empty roster on a live call is the state most needing an action, not an apology. Receipts empty: `"No delivery receipts yet. They appear within seconds of the alert."` Riding assignments empty: `"No riding assignments yet. Assign responding members to apparatus."` + `Assign first member`. |
| **Error** | Call details fail → whole-page error, `role="alert"`, focused, distinguishing unreachable vs rejected, with `Retry` **and** the operational fallback line `"Use radio to confirm the response — tone-out paging is still running."` |
| **Partial** | Expected and load-bearing: roster loads, receipts (alerting plane, separately isolated per N1.5) fails. Roster renders fully; the receipts region renders the placeholder card with `"Delivery receipts couldn't load."` + `Retry delivery receipts`. Announcement is **assertive here, exceptionally**: not knowing whether members were reached is an alerting-visibility failure (permitted class 2), and it names the fallback: `"Delivery receipts couldn't load. You can't confirm who was reached from this screen — use radio."` |
| **Offline** | Banner. Works: last-loaded roster and receipts, each stamped `"As of {time}"`. Queued: riding assignments (they are local decisions and sync later) — announced `"Saved on this device. It will sync when you're back online."` Unavailable: `Escalate now`, `Retry`, and re-sending an alert — all `aria-disabled` with `"Unavailable while offline. Use radio."` |
| **No permission** | A plain member reaching a dispatch they were alerted for sees a **reduced** version — call details and their own response — not a denied panel; the denied panel appears only for the receipts and riding-assignment regions, in place, with `"Delivery receipts are for officers. They show who was reached on this call."` A member reaching a dispatch they were not alerted for gets the full-page denied panel: `"This call wasn't sent to you, so you can't see it. Ask an officer if you need the detail."` |

### W5 — `/roster` Member roster

**Landmarks & headings.** `banner`, `main#main`, `h1` `Members`, `h2` `Filters` (`form role="search"`), `h2` `Members` over the table, `nav aria-label="Pagination"`.

**Keyboard.** `/` focuses search. Filters: status (checkbox group: active / probationary / leave of absence / retired), qual (multi-select listbox), availability (radio group). Table with sortable headers (`aria-sort` on the active column only). Each row: `<th scope="row">` member name link → W6; row actions `Mark off…`, `⋯ More` — always in the DOM, 44 × 44, revealed by opacity on hover but never by existence (§1.6).

**Focus.** Filter change: stays in control, `"{n} members."` debounced 500ms. Sort: stays on header button. `Mark off…` dialog: focus to dialog `h2`; on save, close, focus returns to the trigger, whose name becomes `"Marked off until {date} — change"`, polite `"{name} is marked off until {date}."` Deleting/deactivating a member: confirm dialog naming the member and consequence; on confirm the row is removed and focus goes next-sibling → previous-sibling → `Filters` heading (§1.6).

**Screen-reader narration.** Row order: name → rank → status chip text → quals as a comma-joined sentence (`"Qualifications: interior, driver operator."`) → availability chip text. The quals cell is never a row of unlabelled badges; each badge's text is in the accessible name. Table caption: `"Members. {n} shown of {total}. Sorted by {column}, {direction}."`

**Targets & density.** Compact declared; 44px rows; card list below `lg`. Status and qual chips wrap rather than truncate (+40% expansion tolerance).

**Motion.** #5 (removed), #9 toast (instant), #12 expand (instant).

| State | Specification |
|---|---|
| **Default** | Filterable, sortable member table with status, quals, availability. |
| **Loading** | 10 skeleton rows, real headers, `aria-busy`, `"Loading members."` → `"{n} members loaded."` |
| **Empty** | No members at all: `"No members yet. Add the department's members to start alerting them."` + `Add a member`. Filtered to nothing: `"No members match these filters."` + `Clear filters`. |
| **Error** | `"We couldn't load the member roster."` (unreachable) vs `"The roster request was rejected by the server. Try again, and tell the chief if it keeps happening."` `Retry` present; filters survive. |
| **Partial** | Members load; per-member qual currency (which depends on the certifications service, F3.7) can fail. Rows render with the quals cell reading `"Qualifications couldn't load"` + warning glyph + in-cell `Retry`. Polite: `"Qualifications couldn't load for {n} members. Names and statuses are complete."` This matters operationally — a stale qual list is how an unqualified member gets assigned. |
| **Offline** | Banner. Works: last-loaded page with `"As of {time}"` in the caption. Queued: `Mark off` changes (they affect alerting eligibility and must survive) — `"Saved on this device. It will sync when you're back online."` Unavailable: search, filter, sort beyond cache, add/deactivate member — `aria-disabled` + reason. |
| **No permission** | A plain member gets a reduced roster (names, ranks, availability only — no contact details, no status history) rather than a denied page, because a member legitimately needs to know who is on the department. The withheld columns render the inline denied note `"Contact details are for officers and administrators."` A member reaching it with the member role removed entirely gets the full denied panel naming the chief. |

### W6 — `/roster/:id` Member detail

**Landmarks & headings.** `banner`, `main#main`, `h1` `"{Member name}"`, `nav aria-label="Member sections"` (jump links), then `h2` `Contact and status`, `h2` `Qualifications`, `h2` `Certifications`, `h2` `LOSAP points`, `h2` `Attendance`, `h2` `Availability`. Card titles within a section are `h3`.

**Keyboard.** Section nav single tab stop with arrows. `Contact and status` is an editable form (9 fields → **error summary required**, §1.10). Certifications table with per-row `View`, `Replace attachment`, `Remove` (44 × 44, always present). Attendance is a paginated table. `Escape` closes any dialog and returns focus to its trigger.

**Focus.** Entering edit mode: focus to the first field. Save success: focus stays on `Save changes`, whose label returns to `Save changes` and is `aria-disabled` until the form is dirty again; polite `"Changes saved."` Save failure (validation): error summary. Save failure (network): the error banner. Removing a certification: confirm dialog naming the certification and its effect on quals (`"Remove Firefighter I? {Name} will lose the interior qualification and won't be eligible for interior assignments."`); on confirm, focus goes to the next certification row, or to `Add a certification` if the list is now empty. Attachment upload completing in the background: no focus move, polite `"{filename} attached."`

**Screen-reader narration.** `h1` is the member's name alone; rank and status follow as the first text in `Contact and status`, not appended to the heading. LOSAP: the running total is text before the chart (`"LOSAP points this year: 142 of 150 needed."`), chart has a `Show as table` toggle. Certification rows read: name → issuing authority → `"Expires {date}"` or `"Expired {date}"` → status chip text. An expired certification's row additionally carries `aria-describedby` reading `"This certification has expired and affects {qual} eligibility."`

**Targets & density.** Comfortable (a detail screen, not a data grid). 44 × 44 throughout; two-column at `lg`+, one column below `md`.

**Motion.** #10 chart draw-in (removed), #12 expand (instant), #9 toast (instant).

| State | Specification |
|---|---|
| **Default** | Six sections, one editable form, three tables, one chart with a table equivalent. |
| **Loading** | Per-section skeletons; the `h1` name comes from the route payload and never skeletonizes. `"Loading {name}'s record."` → `"{Name}'s record loaded."` |
| **Empty** | Per-section: certifications `"No certifications recorded. Add one to make {name} eligible for qualifications that need it."` + `Add a certification`. LOSAP `"No points recorded this year yet. Points come from calls, drills, and shifts."` + `See point rules`. Attendance `"No attendance recorded yet."` + `Record attendance`. Quals `"No qualifications. Add a certification to grant one."` + `Add a certification`. |
| **Error** | Whole-record failure: `role="alert"`, focused, unreachable vs rejected, `Retry`. Unsaved edits are preserved in the form and the message says so: `"Your unsaved changes are still here."` |
| **Partial** | Six independent sections. Loaded ones render; failed ones show the placeholder + `Retry {section}`. Polite: `"{n} of 6 sections couldn't load. The rest is available."` The `Qualifications` section failing escalates its own inline note to name the consequence (`"Eligibility can't be confirmed from this screen."`) but stays polite. |
| **Offline** | Banner. Works: cached record with `"As of {time}"`. Queued: contact and availability edits. Unavailable: attachment upload (files can't be queued reliably), certification removal, and `Retry` — `aria-disabled` + `"Unavailable while offline."` |
| **No permission** | A member viewing another member sees `Contact and status` (name, rank, quals) only; `Certifications`, `LOSAP points`, and `Attendance` each render the in-place denied panel: `"{Section} is visible to the member themselves, officers, the training officer, and the chief."` A member viewing **their own** record sees everything but the editable fields the admin owns (rank, status, agency ID), which render as read-only text with `aria-describedby` `"Only an administrator can change this."` — read-only, not hidden, so the member can see what is on their record. |

### W7 — `/shifts` Duty shifts & coverage

**Landmarks & headings.** `banner`, `main#main`, `h1` `Duty shifts`, `h2` `Coverage this week` (summary), `h2` `Shifts` over the calendar/list, `h2` `Filters`.

**Keyboard.** The calendar is the hard part and is specified explicitly. It is a `role="grid"` with `aria-labelledby` the `h2`, one tab stop, roving `tabindex`: `←/→` move a day, `↑/↓` move a week, `Home`/`End` move to the start/end of the week, `PageUp`/`PageDown` move a month, `Enter` opens the day's shift list. A `View as list` toggle is provided and is **not a lesser path** — it is a full-fidelity equivalent, first in the tab order after the filters, and is the default below `md`. Shift cards carry `Claim shift` / `Give back` / `Request swap` buttons, 44 × 44.

**Focus.** Calendar day activation: focus to the day panel's `h3` (`tabindex="-1"`). Claim: per §3.4 — focus stays on the button through success; on a lost race, focus moves to `See other shifts` *before* the claim button is removed. Give back: confirm dialog (reversible within a window → still confirm, because another member's plans depend on it) naming the shift; focus returns to the trigger, now `Claim shift`. Swap request: dialog, focus to dialog `h2`, on send focus returns to trigger, polite `"Swap request sent to {name}."`

**Screen-reader narration.** Each grid cell's accessible name is a full sentence: `"Tuesday 8 September. Night shift, 18:00 to 06:00. 2 of 3 positions filled. Needs a driver operator."` — coverage shortfall is in the name, not only in a colour. Coverage summary reads as text first: `"This week: 12 shifts, 9 fully covered, 2 short, 1 missing a required qualification."` The `Show as table` equivalent of the coverage bar is present.

**Targets & density.** Comfortable. Calendar cells are 44 × 44 minimum at `lg`; below `md` the calendar is replaced by the list view rather than shrunk — **a 7-column month grid cannot hold 44px cells on a phone and is not made to try** (flagged layout).

**Motion.** #12 expand (instant), #9 toast (instant), #5 (removed).

| State | Specification |
|---|---|
| **Default** | Coverage summary + calendar (or list) of shifts with claim/give-back/swap actions. |
| **Loading** | Calendar grid renders with real day cells and skeleton shift chips; `aria-busy` on the grid. `"Loading shifts."` → `"{n} shifts this month. {m} open."` |
| **Empty** | No shifts defined: `"No duty shifts have been set up. An officer defines shifts and the positions each one needs."` + `Set up shifts` (officer) or, for a member, the same sentence with `See who to ask` naming the officers. No *open* shifts: `"Every shift this month is covered. Nothing to claim."` — a good empty state, no action. |
| **Error** | `"We couldn't load the shift calendar."` vs `"The shift request was rejected by the server."` `Retry`; the selected month and filters survive. |
| **Partial** | Shifts load; per-shift qualification-eligibility checks (F2.2/F3.7) can fail. Shifts render, `Claim` stays enabled, and each card carries `"We couldn't check your qualifications for this shift — you may be turned down after claiming."` with the warning glyph. Polite: `"Qualification checks couldn't run for {n} shifts."` The claim is not silently blocked and not silently allowed — the uncertainty is stated. |
| **Offline** | Banner with the §3.4 #6 wording: `"You're offline. You can see the schedule, but you can't claim a shift — someone else may take it, and we can't hold it for you."` `Claim shift` is `aria-disabled` with that exact reason on describedby. Works: viewing the cached month. Queued: nothing on this screen. |
| **No permission** | Members see the calendar and their own shifts and can claim; `Set up shifts`, `Edit shift`, and `Approve swap` render as `aria-disabled` controls with `"Only officers and the chief can change shift definitions."` — visible, not hidden. A user with no shift access at all gets the full denied panel. |

### W8 — `/attendance` Attendance & LOSAP points

**Landmarks & headings.** `banner`, `main#main`, `h1` `Attendance and points`, `h2` `Point totals` (chart + table), `h2` `Record attendance` (form), `h2` `Attendance history` (table), `h2` `Filters`.

**Keyboard.** `Record attendance` is a multi-select over the member roster: a `role="listbox" aria-multiselectable="true"` with roving `tabindex`, `Space` toggles, `Shift+↑/↓` extends, `Ctrl+A` selects all filtered, and a plain checkbox-list fallback toggle for users who prefer it (`View as checkboxes`), which is in the tab order and not hidden. Activity type is a radio group. Date is `input type="date"`. The history table is sortable with `aria-sort`.

**Focus.** Submitting attendance: on success focus stays on `Record attendance`, polite `"Attendance recorded for {n} members. {activity}, {date}. Points applied."` On validation failure (no members, or no activity type): the error summary — this form is 4 fields but the multi-select makes error counts non-obvious, so the summary is required here regardless of the five-field threshold. On network failure: the error banner, selections preserved. Bulk undo: a 10-second `Undo` button in the confirmation region, focusable, announced with the confirmation.

**Screen-reader narration.** The listbox's accessible name announces selection state continuously: `"{n} of {m} members selected."` in `#status-live`, debounced 500ms, not per keystroke. Point totals read as text first: `"{Name}: {n} points this year."` Chart has a `Show as table` toggle. History rows read: date → activity → member count → `"Recorded by {name}"`.

**Targets & density.** Compact declared for the history table (44px rows); the multi-select list is **comfortable at 44px rows with 8px separation** even though it is dense — a mis-click here credits the wrong member's LOSAP points.

**Motion.** #10 chart (removed), #9 toast (instant).

| State | Specification |
|---|---|
| **Default** | Totals, a bulk attendance recorder, and a sortable history. |
| **Loading** | Skeleton rows in both tables; the recorder's member list shows skeleton rows but the activity/date controls are live immediately. `"Loading attendance."` → `"{n} attendance records. {m} members."` |
| **Empty** | No history: `"No attendance recorded yet. Record attendance for a call, drill, meeting, or work detail to start earning LOSAP points."` + `Record attendance` (which focuses the form's first control). No point rules configured: `"No point rules are set up, so nothing earns points yet."` + `Set up point rules` → `/admin`. |
| **Error** | `"We couldn't load attendance."` vs `"The attendance request was rejected by the server."` `Retry`. **Any in-progress selection in the recorder survives** and the message says so. |
| **Partial** | History loads; point totals (a computed aggregate) can fail. History renders; the totals region shows the placeholder + `Retry point totals`. Polite: `"Point totals couldn't load. Attendance history is complete."` Recording attendance stays enabled — capture must not depend on the aggregate. |
| **Offline** | Banner. Works: cached history and totals with `"As of {time}"`. Queued: **recording attendance is queued** and announced `"Saved on this device for {n} members. It will sync when you're back online."` — attendance is captured at drills in bays with no signal, so this is the norm. Unavailable: sorting/filtering beyond cache, point-rule changes. |
| **No permission** | A member sees only their own totals and their own history, as a reduced page with `h1` `Your attendance and points`; `Record attendance` and other members' rows are absent from the data (server-side), and the page carries the in-place note `"You're seeing your own record. Administrators and the chief see everyone."` A user with no access gets the full denied panel naming the administrator and the chief. |

### W9 — `/training` Certifications & expiry

**Landmarks & headings.** `banner`, `main#main`, `h1` `Certifications`, `h2` `Expiring soon`, `h2` `All certifications`, `h2` `Filters`, `nav aria-label="Pagination"`.

**Keyboard.** `/` focuses search. Filters: certification type (listbox), expiry window (radio group: 30/60/90 days/all), member status (checkbox group). Table sortable, `aria-sort` on the active column. Row actions: `View attachment`, `Renew…`, `Remind member` — 44 × 44, always in the DOM. `Remind member` is a single-activation button that becomes `Reminded {time}` and is `aria-disabled` for 24h with the reason on describedby.

**Focus.** `Renew…` dialog: focus to dialog `h2`; on save, close, focus returns to the trigger row's first control; polite `"{Certification} renewed to {date}. {Name} keeps the {qual} qualification."` Bulk `Remind all expiring`: confirm dialog naming the count; on confirm, focus returns to the button, polite `"Reminders sent to {n} members."`

**Screen-reader narration.** `Expiring soon` reads its count as text first: `"{n} certifications expire in the next 90 days. {m} have already expired."` Row order: member name → certification → issuing authority → `"Expires {date}"` / `"Expired {date}"` → the qual it grants → status chip text. **Expiry is stated as an absolute date plus a relative phrase** (`"Expires 3 November 2026, in 58 days"`) — a relative phrase alone is ambiguous, an absolute date alone is hard to triage.

**Targets & density.** Compact declared; 44px rows; card list below `lg`.

**Motion.** #5 (removed), #9 toast (instant), #12 expand (instant).

| State | Specification |
|---|---|
| **Default** | An expiring-soon summary above a filterable, sortable certification table. |
| **Loading** | Real headers + 10 skeleton rows; the expiring-soon count region shows a skeleton. `"Loading certifications."` → `"{n} certifications. {m} expiring in 90 days."` |
| **Empty** | None recorded: `"No certifications recorded yet. Add certifications so qualifications and ISO reporting have something to count."` + `Add a certification`. None expiring (filtered): `"Nothing expires in the next {n} days."` — a good empty state; action `See all certifications`. Filter to nothing: `"No certifications match these filters."` + `Clear filters`. |
| **Error** | `"We couldn't load certifications."` vs `"The certification request was rejected by the server."` `Retry`; filters survive. |
| **Partial** | Certifications load; attachment availability (object storage) can fail independently. Rows render; the attachment cell reads `"Attachment unavailable"` + warning glyph + in-cell `Retry`. Polite: `"Attachments couldn't load for {n} certifications. The records themselves are complete."` |
| **Offline** | Banner. Works: cached list with `"As of {time}"`. Queued: renewal date edits. Unavailable: attachment view/upload and `Remind member` (a reminder that queues could fire days late and mislead) — `aria-disabled` with `"Unavailable while offline."` |
| **No permission** | A member sees only their own certifications, page `h1` `Your certifications`, with the in-place note `"You're seeing your own certifications. The training officer and the chief see everyone's."` `Renew…` and `Remind member` are `aria-disabled` with `"Only the training officer and the chief can renew a certification."` No-access users get the full denied panel naming the training officer. |

### W10 — `/training/drills` Drills & training events

**Landmarks & headings.** `banner`, `main#main`, `h1` `Drills and training`, `h2` `Upcoming`, `h2` `Past`, `h2` `Filters`. Each drill card title is `h3`.

**Keyboard.** Cards in a `<ul>`; each card contains `Sign up` / `Cancel sign-up` (member), `Take attendance` / `Edit drill` (training officer), all 44 × 44. Tab order runs card by card, controls in visual order. `Escape` closes the attendance dialog. Date-range filter uses two `input type="date"`.

**Focus.** `Sign up`: focus stays on the button, which becomes `Cancel sign-up`; polite `"You're signed up for {drill}, {date} at {time}. {n} of {m} spots taken."` `Cancel sign-up`: reversible → executes immediately with a 10s focusable `Undo`, polite `"Sign-up cancelled. {n} spots now open."` `Take attendance` opens the W8 recorder pre-filtered to that drill, as a dialog: focus to dialog `h2`; on save, close, focus to the trigger, polite `"Attendance recorded for {n} members. Points applied."` Deleting a drill: confirm naming the drill and the sign-ups lost; on confirm focus goes next-card → previous-card → the `Upcoming` heading.

**Screen-reader narration.** Card reading order: drill name → date and time as an absolute string → location → `"{n} of {m} spots taken"` → hours credited → your sign-up status chip text → controls. Full/closed drills state it in the button's accessible name: `"Sign up — full, join the waiting list"`.

**Targets & density.** Comfortable. Card grid at `lg`+, single column below `md`. 44 × 44 throughout.

**Motion.** #12 expand (instant), #9 toast (instant).

| State | Specification |
|---|---|
| **Default** | Upcoming and past drills as cards with sign-up and attendance actions. |
| **Loading** | Skeleton cards matching the final card shape, `aria-busy` on each list. `"Loading drills."` → `"{n} upcoming drills, {m} past."` |
| **Empty** | No upcoming: `"No drills scheduled. Members can't sign up until the training officer schedules one."` + `Schedule a drill` (training officer) / `See past drills` (member). No past: `"No drills have been held yet."` — no action. |
| **Error** | `"We couldn't load drills."` vs `"The drill request was rejected by the server."` `Retry`; filters survive. |
| **Partial** | Upcoming loads, past fails (or vice versa) — two independent queries. The failed list shows the placeholder + `Retry {list}`. Polite: `"{List} couldn't load. {Other list} is available."` |
| **Offline** | Banner. Works: cached lists with `"As of {time}"`. Queued: sign-up and cancellation, announced `"Saved on this device. It will sync when you're back online."` — spots are not capacity-critical the way shift claims are (a drill over-signup is a training-officer problem, not a staffing failure), so unlike §3.4 #6 these **are** queued, and the card says so: `"Queued — your spot isn't confirmed until this syncs."` Unavailable: scheduling, editing, attendance. |
| **No permission** | Members see and sign up; `Schedule a drill`, `Edit drill`, `Take attendance` are `aria-disabled` with `"Only the training officer and the chief can schedule drills and take attendance."` No-access users get the full denied panel naming the training officer. |

### W11 — `/apparatus` Apparatus registry & out-of-service

**Landmarks & headings.** `banner`, `main#main`, `h1` `Apparatus`, `h2` `Out of service` (surfaced first — it is the operationally urgent set), `h2` `All apparatus`, `h2` `Filters`.

**Keyboard.** `/` focuses search. Cards or table (density toggle); each apparatus row/card carries `Open` (→ W12), `Place out of service…` / `Return to service…`, `Start a check`, all 44 × 44. **Out-of-service is a two-step button + confirm dialog; there is no slide-to-confirm** (§1.6).

**Focus.** `Place out of service…`: confirm dialog with a required reason field and an optional expected-return date; focus to the dialog `h2`; the destructive button is not the focus target. On confirm: dialog closes, focus returns to the trigger (now `Return to service…`), and `#alert-live` announces **assertively** — permitted class (3), an irreversible-in-effect operational change: `"{Apparatus} is out of service. It's been removed from riding assignments and the alert roster. Reason: {reason}."` `Return to service…`: same pattern, polite announcement. `Start a check` navigates to W12's check section with focus on its `h2`.

**Screen-reader narration.** `Out of service` region reads its count first: `"{n} apparatus out of service."` or, when empty, the good-empty sentence. Row order: unit ID → type → status chip text → `"Last checked {date} by {name}"` → open defects count as text → next test due as an absolute date. Status is never the icon alone.

**Targets & density.** Comfortable by default (the apparatus officer often uses this on a tablet on the apparatus floor); a `Compact` density toggle exists for the chief's desktop and keeps 44px rows. Below `md`, cards.

**Motion.** #9 toast (instant), #12 expand (instant).

| State | Specification |
|---|---|
| **Default** | An out-of-service region above the full registry. |
| **Loading** | Skeleton cards/rows; `aria-busy`. `"Loading apparatus."` → `"{n} apparatus. {m} out of service."` |
| **Empty** | No apparatus: `"No apparatus registered. Add the department's apparatus so checks, defects, and riding assignments have something to attach to."` + `Add apparatus`. Out-of-service empty: `"Nothing is out of service. Every apparatus is available."` — good empty, no action. Filtered to nothing: `"No apparatus match these filters."` + `Clear filters`. |
| **Error** | `"We couldn't load the apparatus registry."` vs `"The apparatus request was rejected by the server."` `Retry`. |
| **Partial** | Registry loads; per-apparatus check compliance and next-test-due (separate aggregate) can fail. Rows render with those cells reading `"Check status unavailable"` + warning glyph + in-cell `Retry`. Polite: `"Check status couldn't load for {n} apparatus. The registry is complete."` The out-of-service *flag itself* failing is escalated: if the OOS query fails, the region shows `"We can't confirm what's out of service. Check the board before you roll."` and announces **assertively** (permitted class 2 — an availability-visibility failure). |
| **Offline** | Banner. Works: cached registry with `"As of {time}"`. Queued: **placing out of service is queued**, because an apparatus found broken in a bay with no signal must still be marked, and the confirmation says `"Saved on this device. Tell the officer by radio as well — this hasn't reached the server yet."` Unavailable: adding apparatus, editing the registry. |
| **No permission** | Members see the registry read-only, including out-of-service status (they need to know what's available), with all action controls `aria-disabled` and `"Only the apparatus officer and the chief can change apparatus status."` No-access users get the full denied panel naming the apparatus officer. |

### W12 — `/apparatus/:id` Apparatus detail — checks, SCBA, testing, defects

**Landmarks & headings.** `banner`, `main#main`, `h1` `"{Unit ID} — {type}"`, `nav aria-label="Apparatus sections"`, then `h2` `Status`, `h2` `Check history`, `h2` `Open defects`, `h2` `SCBA`, `h2` `Testing schedule`, `h2` `Maintenance`, `h2` `Compartment inventory`. Card and table titles within a section are `h3`.

**Keyboard.** Section nav one tab stop, arrow keys. Each table is inside a labelled `role="region" tabindex="0"` scroll container (the testing schedule is wide — §1.11). Defect rows: `Open`, `Assign…`, `Close defect…` (44 × 44). SCBA rows: `Record flow test`, `Record hydro`. Testing rows: `Record test result`. `Escape` closes any dialog to its trigger.

**Focus.** `Close defect…`: confirm dialog naming the defect and the apparatus; on confirm, the row leaves the open-defects table and focus goes next-row → previous-row → `Open defects` heading; polite `"Defect closed. {n} open defects remain on {unit}."` `Record test result`: dialog, focus to dialog `h2`; on save, focus returns to the trigger row's first control, polite `"{Test} recorded. Next due {date}."` `Place out of service` from the `Status` section behaves exactly as W11 (assertive announcement, confirm dialog).

**Screen-reader narration.** `Status` reads first and as a sentence: `"{Unit} is in service. Last checked {date} by {name}. {n} open defects. Next test due {date}."` Testing-schedule rows read: test type → last performed date → next due date → status chip text (`Due in {n} days` / `Expired {date}`). SCBA rows read: unit → cylinder → last flow test → hydro due — with the hydro date carrying `aria-describedby` `"A cylinder past hydro date cannot be used."` when overdue.

**Targets & density.** Comfortable; the testing and SCBA tables use compact horizontal padding with 44px rows. Wide tables scroll in their own focusable region.

**Motion.** #12 expand (instant), #9 toast (instant), #8 progress (stepped + text).

| State | Specification |
|---|---|
| **Default** | Seven sections covering status, checks, defects, SCBA, testing, maintenance, inventory. |
| **Loading** | Per-section skeletons; the `h1` unit ID comes from the route payload and never skeletonizes. `"Loading {unit}."` → `"{Unit} loaded. {n} open defects."` |
| **Empty** | Per-section: check history `"No checks recorded for {unit} yet."` + `Start a check`. Open defects `"No open defects."` — good empty, no action. SCBA `"No SCBA units assigned to {unit}."` + `Assign an SCBA unit`. Testing `"No testing schedule set up. Hose, ladder, pump, and aerial tests won't be tracked until one is."` + `Set up testing schedule`. Inventory `"No compartment inventory recorded."` + `Add inventory`. Maintenance `"No maintenance recorded."` + `Record maintenance`. |
| **Error** | Whole-record failure: `role="alert"`, focused, unreachable vs rejected, `Retry`. |
| **Partial** | Seven independent sections. Loaded render; failed show the placeholder + `Retry {section}`. Polite: `"{n} of 7 sections couldn't load. The rest is available."` **Exception:** if `Status` fails, the whole page is treated as **error**, not partial — an apparatus page that cannot say whether the rig is in service is not usably degraded. |
| **Offline** | Banner. Works: cached record with `"As of {time}"`; starting a check works fully offline (§3.2). Queued: check results, defect creation, out-of-service marking. Unavailable: closing a defect, recording a test result, and photo attachment — `aria-disabled` with `"Unavailable while offline."` |
| **No permission** | Members see `Status`, `Open defects`, and `Check history` read-only (they need to know if the rig is usable and whether the check is done); `SCBA`, `Testing schedule`, `Maintenance`, and `Compartment inventory` render the in-place denied panel `"{Section} is for the apparatus officer and the chief."` No-access users get the full denied panel. |

### W13 — `/incidents` Incident list & NERIS submission status

**Landmarks & headings.** `banner`, `main#main`, `h1` `Incidents`, `h2` `Needs attention` (drafts and rejected submissions, first), `h2` `All incidents`, `h2` `Filters`, `nav aria-label="Pagination"`.

**Keyboard.** `/` focuses search. Filters: date range, incident type (listbox), submission status (checkbox group: draft / submitted / rejected / retrying). Table sortable with `aria-sort`; nine columns at `xl`, collapsing to a card list below `lg` (§1.11 flagged case (a) — the columns collapse, the 44px targets do not shrink). Row actions: `Open`, `Retry submission` (only on rejected/failed rows), 44 × 44.

**Focus.** `Retry submission`: focus stays on the button, label → `Retrying…`, `aria-busy` on the row. On success, polite `"Incident {id} submitted to NERIS."` and the button becomes `Submitted — view receipt`. On failure, §3.3 #5/#6 wording, **assertive**, focus to the row's error text (`tabindex="-1"`). Bulk `Retry all failed`: confirm naming the count; on confirm focus returns to the button, polite `"Retrying {n} submissions."` then a per-outcome summary.

**Screen-reader narration.** `Needs attention` reads its count first: `"{n} incidents need attention: {m} drafts, {k} rejected by NERIS."` Row order: incident number → date and time → type → address → `"{n} apparatus, {m} personnel"` → submission status chip text with its date. **A failed submission is never rendered as an empty status cell** (F7.7 — never silently dropped): the cell always carries the `Rejected — needs fixing` chip text and the reason on `aria-describedby`.

**Targets & density.** Compact declared; 44px rows; card list below `lg`. The table lives in a labelled focusable scroll region.

**Motion.** #10 chart (n/a here), #9 toast (instant), #5 (removed).

| State | Specification |
|---|---|
| **Default** | A needs-attention region above the full incident table with NERIS status per row. |
| **Loading** | Real headers + 10 skeleton rows; `aria-busy`. `"Loading incidents."` → `"{n} incidents. {m} need attention."` |
| **Empty** | None recorded: `"No incidents yet. An incident report is created from a dispatch, so it starts mostly written."` + `See the dispatch log`. Needs-attention empty: `"Nothing needs attention. Every incident has been submitted to NERIS."` — good empty, no action. Filtered to nothing: `"No incidents match these filters."` + `Clear filters`. |
| **Error** | `"We couldn't load incidents."` vs `"The incident request was rejected by the server."` `Retry`; filters survive. |
| **Partial** | Incidents load from the local store; NERIS submission status comes from a separate integration and can fail. Rows render; the status cell reads `"NERIS status unavailable"` + warning glyph + in-cell `Retry`. Announcement is **polite but explicit about the consequence**: `"NERIS submission status couldn't load for {n} incidents. You can't tell from this screen whether they were accepted."` |
| **Offline** | Banner. Works: cached list with `"As of {time}"`; opening and editing a draft (W14) works offline. Queued: nothing on this screen. Unavailable: `Retry submission` and `Retry all failed` — `aria-disabled` with `"Unavailable while offline. Submissions retry automatically when you're back online."` |
| **No permission** | Members have no incident-list access. Denied panel: `"Incident reports are for officers and the chief. They contain the department's federal reporting data."` The nav item stays visible and `aria-disabled` with the same reason. |

### W14 — `/incidents/:id` NERIS incident report editor

The largest form in the product and the one most likely to be abandoned. Its accessibility obligation is that a partially-written report is never lost and that a NERIS rejection is always fixable from the screen.

**Landmarks & headings.** `banner`, `main#main`, `h1` `"Incident {number} — {type} at {address}"`, `nav aria-label="Report steps"` (the step list, `role="tablist"`-free — it is a `<ol>` of links with `aria-current="step"` on the active one), then one `h2` per step: `Dispatch and times`, `Location`, `Incident type and actions`, `Apparatus and personnel`, `Narrative`, `Exposure and responder safety`, `Review and submit`. Field group titles are `h3`.

**Keyboard.** Step nav is a normal link list (one tab stop per link is acceptable at seven steps; arrow keys are additionally supported for parity with other composites). Within a step, standard form traversal. `Ctrl+S` is **not** bound — saving is automatic and continuous, and the `Save draft` button exists as the explicit equivalent. Enumeration pickers (NERIS code lists, potentially hundreds of options) are `role="combobox"` with `aria-expanded`, `aria-controls`, `aria-activedescendant` over a filtered `role="listbox"`: type to filter, `↑/↓` move, `Enter` selects, `Escape` closes the list (first press) then clears the filter (second press), and the current match count is announced politely, debounced 500ms, as `"{n} matches."` **Every enumeration picker also accepts free typing of the code itself** for the officer who knows it.

**Focus.** Step change: the new step's `h2` (§1.6), polite `"Step {n} of 7. {step name}."` Autosave completing: no focus move, polite `"Draft saved {time}."` at most once per 60s. Validation failure on `Submit to NERIS`: the error summary listing every failing field across **all** steps, each link carrying its step name (`"Step 3, Incident type: choose a NERIS incident type"`); activating a link switches to that step *and* focuses the field, announcing `"Step 3. {field label}."` NERIS rejection after submit: §3.3 #6, assertive, focus to the error summary now populated with the rejected fields. Adding an apparatus/personnel row: focus to the new row's first field, polite `"Row {n} added."` Removing a row: reversible → immediate with a 10s focusable `Undo`; focus goes to the next row's first field, or to `Add apparatus` if none remain.

**Screen-reader narration.** On load, the pre-population summary from §3.3 #1. Every pre-filled field carries a visible `From dispatch` chip and `aria-describedby` `"Filled automatically from the dispatch. You can change it."` — an officer must be able to tell what was asserted on their behalf. The step list announces progress as text: `"Step {n} of 7. {m} steps complete, {k} have problems."` Required-field policy: most fields are required, so the **optional** ones are marked `(optional)` in the visible label (§1.10).

**Targets & density.** Comfortable throughout — this screen is never compact. 44 × 44 minimum; the narrative textarea is at least 8 rows and resizable. Two-column field layout at `xl` only; single column at `lg` and below.

**Motion.** #8 progress (stepped + `"{n} of 7 steps complete"` text), #12 expand (instant), #9 toast (instant).

| State | Specification |
|---|---|
| **Default** | A seven-step guided form, mostly pre-filled, validating against NERIS enumerations before submit. |
| **Loading** | Step 1 renders real controls immediately with the dispatch-derived values; remaining steps show skeletons until their reference data (NERIS enumerations) loads. `aria-busy` per step. `"Loading the report."` → the §3.3 #1 pre-population announcement. |
| **Empty** | A new report with no pre-population available (CAD data missing): the form renders fully with every field blank and a leading note `"Nothing was filled in automatically — the dispatch data wasn't available for this call. You'll need to enter the times and location by hand."` + the first field focusable. This is the empty state; it is explained, never silent. |
| **Error** | Report fails to load: `role="alert"`, focused, unreachable vs rejected, `Retry`. If a local draft exists, the message adds `"Your unsaved draft from {time} is still on this device and will be restored."` and it is. |
| **Partial** | The report loads but the NERIS enumeration reference data (F7.10, versioned) fails. Every free-text field stays editable; every enumeration picker becomes a text input accepting a raw code, with `aria-describedby` `"The NERIS code list couldn't load. Type the code if you know it, or save a draft and come back."` `Submit to NERIS` is `aria-disabled` with `"You can't submit until the NERIS code list loads, because we can't check your answers first."` Announced politely; the reason is on the button, so it is discoverable from the button itself. |
| **Offline** | Banner. Works: the whole form, every field, autosave to device. Queued: the draft, announced `"Saved on this device."` Unavailable: `Submit to NERIS` — `aria-disabled` with `"You're offline. The report is saved here and you can submit when you're back online."` Nothing typed is ever lost on going offline mid-field. |
| **No permission** | A member has no access: full denied panel `"Incident reports are for officers and the chief."` An officer opening an incident from another department (multi-tenant seam, F9.6) gets `"This incident belongs to another department."` — the same panel, a different sentence, never a generic 403. |

### W15 — `/admin` Department configuration & data export

**Landmarks & headings.** `banner`, `main#main`, `h1` `Department settings`, `nav aria-label="Settings sections"`, then `h2` `Department details`, `h2` `Roles and access`, `h2` `Apparatus and stations`, `h2` `Ranks`, `h2` `LOSAP point rules`, `h2` `Check sheets`, `h2` `Alert rules`, `h2` `Accessibility`, `h2` `Data export`.

**Keyboard.** Section nav one tab stop with arrows. Check-sheet and point-rule editors are ordered lists reordered by `Move up`/`Move down` buttons and `Alt+↑`/`Alt+↓` (§1.6) — never drag-only. The `Accessibility` section holds: `Disable single-key shortcuts` switch, `Reduce motion` override (three-state: `Match my device` / `Always reduce` / `Never reduce`), `Palette` (day/cab/match device), and `Text size` (100/125/150/200%). These are real controls, not a link to OS settings. `Data export` is a form with a format radio group and a `Start export` button.

**Focus.** Section jump: the target `h2`. Saving any section: focus stays on that section's `Save {section}` button, polite `"{Section} saved."` Reordering: focus follows the moved item, polite `"{Item} moved to position {n} of {m}."` **Data export** — the highest-consequence action in the product and, by design, gated by role alone with no step-up (F9.1, N5.2): a confirm dialog naming the exact scope and the consequence, `"Export the whole department dataset? This includes every member's contact details, attendance, and certifications. The chief is notified that you did this."` Focus lands on the dialog `h2`; the destructive button is not the focus target; `Escape` cancels and returns focus to `Start export`. On confirm, focus returns to `Start export` and `#alert-live` announces **assertively** — permitted class (3): `"Export started. The chief has been notified. You'll get a download link when it's ready."` **No password field, no code, no biometric prompt appears in this dialog or anywhere in this flow.** The per-invocation notification is the control (N5.2), and the announcement says so, so the acting user knows it is observed.

**Screen-reader narration.** `Roles and access` renders a real table of role × permission with `<th scope>` on both axes, so the authorization boundary — the only boundary that exists — is readable rather than inferable. Alert-rule settings read their consequence as text: `"Escalate to SMS after 90 seconds with no acknowledgement."` Each rule field's `aria-describedby` states what changing it does to the alert path.

**Targets & density.** Comfortable. 44 × 44 throughout. Single column below `md`.

**Motion.** #12 expand (instant), #9 toast (instant), #8 export progress (stepped + `"{n}%"` text).

| State | Specification |
|---|---|
| **Default** | Nine configuration sections plus the accessibility preferences and data export. |
| **Loading** | Per-section skeletons; `aria-busy`. `"Loading department settings."` → `"Settings loaded."` The `Accessibility` section loads from local preferences and **never** shows a loading state — the user's own accessibility settings must be reachable even when the server is unreachable. |
| **Empty** | Per-section: point rules `"No point rules yet. Nothing earns LOSAP points until you add a rule."` + `Add a point rule`. Check sheets `"No check sheets yet. Apparatus checks need a sheet to follow."` + `Create a check sheet`. Ranks `"No ranks defined. Members will show without a rank."` + `Add a rank`. Alert rules `"No escalation rules. Alerts will go out on push only, with no SMS or voice fallback."` — this empty state is a **warning-styled** empty, because the absence is dangerous (N1.2/F1.4), and it carries the warning glyph and the action `Set up escalation`. |
| **Error** | `role="alert"`, focused, unreachable vs rejected, `Retry`. Unsaved edits in any section survive and the message says so. |
| **Partial** | Nine independent sections. Loaded render; failed show the placeholder + `Retry {section}`. Polite: `"{n} of 9 sections couldn't load."` **Exception:** if `Alert rules` fails to load, its placeholder announces **assertively** (permitted class 2) `"Alert rules couldn't load. You can't confirm how alerts escalate. Don't change anything else until this loads."` — an admin editing around invisible alert rules is exactly the failure mode this product exists to avoid. |
| **Offline** | Banner. Works: `Accessibility` preferences fully (local), and reading cached settings with `"As of {time}"`. Queued: nothing — configuration changes are **not** queued, because a queued alert-rule change that syncs hours later is worse than a rejected one; the banner says `"You're offline. You can change your own accessibility settings, but department settings can't be saved until you're back online."` Unavailable: every `Save {section}` and `Start export`, `aria-disabled` with that reason. |
| **No permission** | Only the chief and administrators reach `/admin`. Everyone else gets the full denied panel: `"Department settings are for the chief and administrators. They control alert rules, point rules, and who can see what."` An administrator reaching `Data export`, which is chief-only, gets the in-place denied panel `"Only the chief can export the department dataset."` — the one place where an in-place denial exists within an otherwise-permitted route, and it is announced politely on section entry. |

## 5. Native screens — `apps/mobile` (React Native)

This surface cannot be prototyped in this run, so every decision below is binding as written. Default palette `cab`; `day` selectable; an `Auto (match ambient light)` option exists but **never overrides a manual choice and never switches during an active alert** — the palette changing under a member mid-response is a legibility failure at the worst moment.

All native screens inherit §1, including the container model (§1.4), the announcement API pairing (§1.5), the gesture-equivalent table (§1.6), and the 56px / 72px target floors (§1.11). `allowFontScaling` is never disabled, on any screen, including the 32px alert address.

### N1 — Incoming alert (full-screen, wakes device)

The single most important screen in the product. It is presented from a locked or backgrounded device by a critical alert (F1.9, N3.2) and must be answerable in one action.

**Container model & reading order.** Root `accessibilityLabel="Incoming call"`. First element: `Text accessibilityRole="header"` carrying `"{incident type}"` at `type.alert.type`; then the address at `type.alert.address` (32px). Reading order is fixed and mandatory — the ordering in §3.1 #3 is the specification, and the three response buttons precede the narrative. This ordering is enforced by DOM/element order, not by `accessibilityElementsHidden` tricks.

**Keyboard / switch / assistive operation.** The screen is a focus trap (§1.6) with one exception: **`Escape` does not dismiss it.** There is no dismiss. The only exits are the three response buttons and the OS back gesture, which backgrounds the app without answering and leaves the notification persistent. With an external keyboard: `Tab` cycles the three response buttons first, then the links; `Enter`/`Space` activates. Switch Control scanning starts on `Responding`. `accessibilityActions` exposes `respond`, `respondDirect`, and `notResponding` as rotor actions so a VoiceOver user can answer without locating the button.

**Focus management.** On present: `setAccessibilityFocus` to the header text node (address is read before buttons). After answering: the screen transitions to N2 with focus on N2's header. On a second dispatch arriving while N1 is open: §3.1 #11 — a new N1 presents above, focus to its header, the first call's N1 remains behind it and is not destroyed. On the app being foregrounded from the notification with the alert already answered: N1 is skipped entirely and N2 opens.

**Narration.** §3.1 #2 assertive announcement on present, via `announceForAccessibilityWithOptions({queue:false})` on iOS and `accessibilityLiveRegion="assertive"` on Android — both, not one. Button accessible names are full sentences: `"Responding — you're going to the station"`, `"Responding direct to scene"`, `"Not responding"`. The elapsed timer is `accessibilityLiveRegion="off"` and is read on demand only, never announced every second.

**Contrast.** `cab`: address `#ffffff` on `#16171a` = **17.92:1**; incident type `#ffc247` on `#0b0b0d` = **12.23:1**; `Responding` button `#35a862` fill with `#0b0b0d` label = **6.49:1** label, **6.49:1** fill-vs-page; `Not responding` `#e8503f` fill with `#0b0b0d` label = **5.29:1**. `day`: address `#101114` on `#ffffff` = **18.88:1**; `Responding` `#0f6c34` / `#ffffff` = **6.53:1**. Every value on this screen clears AAA for its size class except the two button fills, which clear AA and 3:1 non-text comfortably.

**Targets.** `Responding` is full-width × 88px. `Responding direct to scene` and `Not responding` are 72 × 72 minimum, full-width in practice, separated by 16px. Links (`Pre-plan`, `Hydrants`, `Open in maps`) are 72px tall. No control on this screen is under 72px.

**Motion.** #1 entrance (cross-fade at 120ms under reduced motion; arrival carried by sound + haptic + persistent text). Nothing on this screen strobes or flashes (§1.9).

| State | Specification |
|---|---|
| **Default** | Type, address, cross streets, three response buttons, narrative, pre-plan and hydrant links, map handoff, elapsed timer. |
| **Loading** | **Prohibited for the address.** The incident type, address, and cross streets arrive in the notification payload and render immediately with no network call. Only the narrative, pre-plan link, and hydrant link may load; each shows a 56px skeleton and, if still loading after 3 seconds, is replaced by its offline text (below). `#status-live` equivalent: polite `"Loading the dispatch narrative."` — never assertive, never before the address is spoken. |
| **Empty** | The dispatch carries no narrative and no pre-plan: those sections are absent, and the screen states it rather than showing a gap: `"No narrative was sent with this dispatch."` and `"No pre-plan on file for this address."` + a `Add a pre-plan later` note (not an action — this is not the moment). The response buttons are unaffected. |
| **Error** | Narrative/pre-plan fetch fails: inline text `"We couldn't load the narrative. The address above came with the dispatch and is correct."` — the reassurance is required, because a visible failure next to an address makes a member doubt the address. `Retry` button, 72px. **A failure never blocks or delays the response buttons.** The whole screen never enters an error state; there is no fetch it depends on. |
| **Partial** | The expected real state: address and type present, narrative or pre-plan missing. Rendered exactly as Error above, per section, with the warning glyph and a `Retry {section}` button. Announced politely, once, and only after the assertive alert announcement has completed: `"The dispatch narrative couldn't load."` |
| **Offline** | Banner below the header: `"You're offline. This call came through anyway."` Works: reading the alert, and answering — the answer is queued (§3.1 #5) and the button's accessible name becomes `"Responding — queued, not yet sent"`. Queued: the response. Unavailable: the pre-plan, hydrants, and map handoff, each `accessibilityState={{disabled:true}}` with the reason `"Needs a connection."` — present, not removed. The elapsed timer keeps running from the local clock. |
| **No permission** | **Cannot occur.** Stated reason: N1 is presented only to members the server already determined were eligible for this dispatch (F1.2), so an ineligible member never receives it. The adjacent case — a member whose role was removed between fan-out and open — shows the alert in full and answers normally; **the response is accepted and the roster shows it**, because refusing a response at 03:00 from someone standing at the station is worse than a stale roster entry. An officer reconciles it on W4. This is a deliberate decision, recorded in §7. |

### N2 — Alert detail & respond

The screen a member lands on after answering, and the one they return to during the call.

**Container model & headings.** Root label `"Call detail"`. Header text (`accessibilityRole="header"`): `"{incident type} at {address}"`. Section headers: `"Section: Your response"`, `"Section: Call details"`, `"Section: Who's responding"`, `"Section: Pre-plan and hydrants"`.

**Operation.** `Change response` is a 72px segmented control (three options) exposed as `accessibilityRole="radiogroup"` with three `radio` children carrying `accessibilityState={{checked}}`. Map is `accessibilityElementsHidden` with adjacent real text (§1.6) and 56px `+`/`−`/`Open in maps` buttons. `Pre-plan` and `Hydrants` open sheets: `accessibilityViewIsModal`, siblings `importantForAccessibility="no-hide-descendants"`, focus to the sheet header, back gesture and a 56px `Close` button both exit to the invoking control.

**Focus.** Changing a response: focus stays on the control; §3.1 #4 announcement. Sheet open/close as above. A second dispatch arriving: N1 presents over this screen (§3.1 #11). The roster preview updating: no focus move, rate-limited polite announcement per §3.1 #8.

**Narration.** On arrival: `"You're marked responding. {n} others responding. {address}."` Reading order puts `Your response` first — a member re-opening the app mid-call is checking what they said, not reading the narrative again.

**Contrast.** As N1 for the address and buttons. Roster preview chips use §1.2 chip pairings (cab responding `#0c3f22`/`#d6f5e2` = **10.30:1**).

**Targets.** Response control 72px; all other controls 56px minimum, 12px separation.

**Motion.** #3 confirm (instant swap + haptic + announcement), #13 map pin (instant), #2 active-call indicator (static bar + text timer).

| State | Specification |
|---|---|
| **Default** | Your response, call details, a live roster preview, pre-plan and hydrant access. |
| **Loading** | Address and your own response render immediately from local state. Roster preview and pre-plan show 56px skeletons, `accessibilityState={{busy:true}}`. Polite `"Loading who's responding."` → `"{n} responding."` |
| **Empty** | No one else has responded yet: `"You're the only one responding so far. Members were alerted {n} seconds ago."` — no action for a member; for an officer the screen offers `See the full roster` → N3. No pre-plan on file: `"No pre-plan on file for this address."` |
| **Error** | Roster fetch fails: `"We couldn't load who's responding. Your own response was sent and is confirmed."` + 56px `Retry`. The distinction between unreachable and rejected applies here as everywhere. Your own response state is never rendered as uncertain when it is confirmed locally. |
| **Partial** | Roster loads, pre-plan fails (or vice versa). Loaded sections render; failed ones show the warning glyph + `"{Section} couldn't load."` + `Retry {section}`, 56px. Polite, once. |
| **Offline** | Banner. Works: reading the call, changing your response (queued, §3.1 #5). Queued: response changes, each announced `"Saved on this phone. It will send when you have signal."` Unavailable: roster refresh, pre-plan, hydrants, map handoff — disabled with the reason, present in the tree. |
| **No permission** | A member sees their own response and the call details; the full roster is officer-only, so the `Who's responding` section shows a count only (`"{n} responding"`) with the in-place note `"Officers can see who each of them is."` Never a blank section, never a 403. |

### N3 — Live response roster

**Container model & headings.** Root label `"Live response roster"`. Header: `"Who's responding"`. Section headers by group: `"Section: Responding"`, `"Section: Direct to scene"`, `"Section: Not responding"`, `"Section: No response yet"`. Grouping by status is the structure; a flat list sorted by colour is not acceptable.

**Operation.** Each row: name, quals as a sentence, ETA, apparatus assignment, and a 56px `⋯ More` button (never long-press-only, §1.6) exposing `Assign to apparatus`, `Move up`, `Move down` — also registered as `accessibilityActions` so they appear in the VoiceOver/TalkBack rotor. Riding-assignment reordering: `Move up`/`Move down` buttons plus `Alt+↑`/`Alt+↓` with an external keyboard. `Refresh` button, 56px, in the header (pull-to-refresh is an accelerator only).

**Focus.** New response arriving: **no focus move**; `New` chip for 30s; rate-limited polite announcement (§3.1 #8). Reorder: focus follows the row, announcement per §1.6. `⋯ More` sheet: modal, focus to sheet header, close returns to the `⋯ More` button. A row disappearing because a member changed to `Not responding`: the row **moves between groups rather than being destroyed**, and if it held focus, focus moves with it and announces `"{name} moved to Not responding."`

**Narration.** On load: §3.1 #7 counts. Row reading order: name → status (from the group, restated in the row so it survives out-of-context reading) → quals → ETA → apparatus. Quals are a sentence, never a badge row.

**Contrast.** §1.2 chips. Group headers use `color.fg` (13.79:1 cab / 18.88:1 day).

**Targets.** 56px rows, 12px separation; `⋯ More` 56 × 56.

**Motion.** #4 row insert (New chip, no movement, under reduced motion), #11 sync spinner (static text + counter).

| State | Specification |
|---|---|
| **Default** | Four status groups with counts, member rows, riding assignments. |
| **Loading** | Group headers render immediately with skeleton rows beneath, `busy` state. Polite `"Loading the roster."` → the §3.1 #7 counts. |
| **Empty** | No responses yet: `"No one has responded yet. Members were alerted {n} seconds ago."` with a live elapsed text and, for an officer, one action: `Escalate now` (56px). Per-group empty: the group header renders with `"None"` as its content — groups are never hidden, because a missing `Not responding` group reads as "nobody declined" rather than "this section is absent." |
| **Error** | `"We couldn't load the roster."` (unreachable) vs `"The roster request was rejected by the server."` (rejected) + 56px `Retry` + the operational fallback `"Use radio to confirm who's coming."` |
| **Partial** | Responses load but qualifications (F3.7) fail: rows render with `"Qualifications couldn't load"` in place of the quals sentence, warning glyph, and `Retry`. Polite: `"Qualifications couldn't load. Don't assign an interior position from this screen until they do."` — the consequence is named because assigning on a stale qual is a safety failure. |
| **Offline** | Banner. Works: the last-loaded roster, stamped `"As of {time}"` in the header — mandatory here, an unstamped stale roster is dangerous. Queued: riding assignments. Unavailable: `Refresh`, `Escalate now` — disabled with `"Unavailable while offline. Use radio."` |
| **No permission** | Members reaching N3 see counts per group but not names: each group renders `"{n} responding"` with the in-place note `"Officers can see who each of them is."` `Assign to apparatus` and reordering are absent from the tree for members (they are not merely disabled, because the member has no path to the role). The screen is never blank. |

### N4 — Alert-path self-test (F1.10)

The screen that lets a member prove their own alert path works, without a real call. Its accessibility obligation is that a **failure** is unmistakable and actionable, because a member who believes a broken path works will miss a call.

**Container model & headings.** Root label `"Alert self-test"`. Header: `"Test your alert path"`. Section headers: `"Section: What this does"`, `"Section: Results"`.

**Operation.** One 72px `Send a test alert to me` button. Results render as an ordered list of channel rows (push, SMS, voice), each with a status chip and a `What to do` disclosure. `Escape` / back exits normally; nothing is trapped.

**Focus.** On starting: focus stays on the button, which becomes `Testing…` with `busy` state. On each channel result arriving: **no focus move**, polite per-channel announcement `"Push: delivered in {n} seconds."` On completion, all-pass: polite `"Test complete. All three channels reached you. Your alert path is working."` focus unchanged. On completion with any failure: focus moves to the results region header (`setAccessibilityFocus`) and the announcement is **assertive** — permitted class (2): `"Test failed. {Channel} did not reach you. You may not get called out. Here's what to do."` A failure is the one outcome on this screen that interrupts.

**Narration.** Channel rows read: channel name → status chip text → elapsed time → the fix sentence. The fix sentences are concrete and are content, not placeholders: push failing → `"Open your phone's settings and allow Boxalarm critical alerts and notifications."`; SMS failing → `"Check that {phone number} is your current number in your profile."`; voice failing → `"Your carrier may be blocking the call. Tell the chief."`

**Contrast.** Pass chips cab `#0c3f22`/`#d6f5e2` = **10.30:1**; fail chips cab `#7a1109`/`#ffe9e6` = **9.44:1**, with the double 3px border and the ▲ glyph (§1.8) so a failure is unmistakable in forced-colours and in monochrome.

**Targets.** Test button 72px; disclosures 56px.

**Motion.** #11 sync spinner (static `"Waiting for {channel}…"` + a stepped `{n} of 3` counter under reduced motion), #8 progress (stepped + text).

| State | Specification |
|---|---|
| **Default** | An explanation, one test button, and a three-row result list from the last run with its timestamp. |
| **Loading** | The run itself: each channel row shows `"Waiting…"` with `busy`, resolving independently and announcing as it lands. A channel not resolving within 60s is **not** left pending — it resolves to `Timed out` with the failure treatment, because an indefinitely pending row reads as "probably fine." |
| **Empty** | Never run before: `"You haven't tested your alert path yet. A test sends a real alert to your phone through all three channels — push, text, and voice — without calling anyone out."` + `Send a test alert to me`. |
| **Error** | The test could not be started: `"We couldn't start the test."` (unreachable) vs `"The test request was rejected by the server. Tell the chief — this is a problem on our side, not your phone."` (rejected). Both + `Retry`. The distinction matters most here: a member must not conclude their phone is broken when the server is. |
| **Partial** | Some channels reported, others timed out. Reported rows show their result; timed-out rows show `Timed out` with the failure chip and the fix sentence. Announcement is **assertive**: `"Test partly failed. {n} of 3 channels reached you. {Channel} did not."` A partial result on this screen is a failure, not a degradation. |
| **Offline** | Banner. Works: reading the last result, stamped `"Last tested {date} {time}"`. Queued: nothing — a self-test cannot be queued, because a test that runs hours later proves nothing about now. Unavailable: `Send a test alert to me`, disabled with `"You're offline, so a test would only prove you're offline. Try again when you have signal."` |
| **No permission** | **Cannot occur for a member's own path** — every member may test their own, by design (F1.10). Testing *another member's* path is admin-only; a member reaching that variant sees the in-place denied panel `"You can test your own alert path. Only the chief and administrators can test someone else's."` |

### N5 — Home: my status & availability

The app's landing screen and the tab-bar root. It is what a member sees when nothing is happening, and it must make "am I reachable?" answerable at a glance.

**Container model & headings.** Root label `"Home"`. Header: `"{First name}"`. Section headers: `"Section: Your alert path"`, `"Section: Your availability"`, `"Section: Active call"` (only when live, and rendered first), `"Section: Coming up"`, `"Section: Waiting to sync"` (only when the queue is non-empty). Tab bar is `accessibilityRole="tablist"` with five `tab` children (`Alerts`, `Duty`, `Apparatus`, `Records`, `Settings`), `accessibilitySelected` on the active one.

**Operation.** `Your availability` is a 72px segmented control (`Available` / `Marked off`) as a `radiogroup`; choosing `Marked off` opens a sheet for the until-date. `Your alert path` shows the last self-test result with a 56px `Test now` → N4. Queued items each have a 56px `Details` and the queue has one `Retry sync now`. Pull-to-refresh is an accelerator; a 56px `Refresh` sits in the header.

**Focus.** Availability change: focus stays on the control; polite `"You're marked off until {date}. You'll still get alerts, but the officer knows not to expect you."` — the second sentence is required content (§3.1 #12). Sheet: modal, focus to sheet header, close returns to the control. Active call appearing: §3.1 #11, assertive, and focus does **not** move (the member may be typing); the announcement plus the persistent bar carry it. Queue draining in the background: no focus move, polite `"{n} items synced."` Tab change: focus to the new screen's header.

**Narration.** On load, in this order: any active call → alert-path status as a sentence (`"Your alert path was working when you tested it on {date}."` or `"You haven't tested your alert path."`) → availability → queue count → what's coming up. The alert-path status is deliberately second, above availability: it is the answer to the question this product exists for.

**Contrast.** Chips per §1.2. `Marked off` uses the neutral hatch treatment (cab `#26282e`/`#d6d8dd` = **10.33:1**) — not a danger colour, because being marked off is legitimate, and colouring it red trains members not to use it.

**Targets.** Availability control 72px; everything else 56px; tab-bar items 56px tall with 12px separation.

**Motion.** #2 active-call bar (static bar + text timer under reduced motion), #11 sync spinner (static text + counter).

| State | Specification |
|---|---|
| **Default** | Alert-path status, availability, upcoming shifts and drills, and the sync queue when non-empty. |
| **Loading** | Availability and queue render from local state instantly. Alert-path status and `Coming up` show 56px skeletons with `busy`. Polite `"Loading your home screen."` → `"Home loaded."` |
| **Empty** | Nothing coming up: `"Nothing scheduled for you. Open shifts and drills show up here when you sign up."` + `See open shifts`. Queue empty: the section is **absent**, and its absence is the correct signal (an empty queue needs no explanation); the last sync time appears in the header instead as `"Everything synced {time}"`. Never tested: covered by the alert-path sentence above, with `Test now`. |
| **Error** | `"We couldn't load your home screen."` (unreachable) vs `"The request was rejected by the server."` (rejected), + 56px `Retry`. **Availability and the queue still render**, because both are local — an error in the remote sections never blanks the local ones. |
| **Partial** | The routine state. Local sections always render; remote sections fail independently, each showing the warning glyph + `"{Section} couldn't load."` + `Retry {section}`. Polite, once. **Exception:** if `Your alert path` cannot be read, it announces assertively (permitted class 2) `"We can't confirm your alert path is working. Run a test."` with focus moved to the `Test now` button — not knowing whether you will be paged is the one uncertainty this screen may not present quietly. |
| **Offline** | Banner. Works: availability changes (queued), reading everything cached with `"As of {time}"`, and the whole Apparatus stack. Queued: availability changes and anything already in the queue, listed by name with the `Queued — not yet synced` chip. Unavailable: `Test now` (see N4), `Retry sync now`, `Refresh` — disabled with reasons. On reconnect: polite `"Back online. {n} items synced."`, or **assertive** if any item failed: `"Back online, but {n} items couldn't sync. Open them to fix."` |
| **No permission** | **Cannot occur** — Home is scoped to the signed-in member's own data and every member has it. The adjacent case is a deactivated member: the whole screen is replaced by the denied panel `"Your membership is not active"` + `"Your account is marked {status}. You won't be alerted. The chief or an administrator can reactivate it."` The alert-path section is hidden in this case because it would be misleading. |

### N6 — Open shifts

**Container model & headings.** Root label `"Open shifts"`. Header: `"Open shifts"`. Section headers: `"Section: Shifts you're qualified for"`, `"Section: Other open shifts"`. Grouping by eligibility, not by date alone, so a member does not tab through shifts they cannot take.

**Operation.** Each shift is a card with a 72px `Claim shift` primary button. Swipe-to-claim is an accelerator; the button is the path, and `claim` is registered as an `accessibilityAction`. A 56px `Filters` control opens a modal sheet (date range, position, apparatus). 56px `Refresh` in the header.

**Focus.** Claim: §3.4 in full — success keeps focus on the button (now `Give back this shift`); a lost race moves focus to `See other shifts` **before** the card's claim button is removed; a missing-qual block keeps focus on the now-`disabled`-state button with the reason on the accessibility hint. Filters sheet: modal, focus to sheet header, on apply the sheet closes, focus returns to `Filters`, polite `"{n} shifts match."`

**Narration.** On load: §3.4 #1. Card reading order: shift name → date and time as an absolute string → positions needed as a sentence (`"Needs a driver operator and two firefighters"`) → `"{n} of {m} positions filled"` → your eligibility as text (`"You're qualified for this"` / `"Needs {qual}, which you don't hold"`) → the claim button. Eligibility is never conveyed by placement or colour alone.

**Contrast.** Eligible cards use the standard surface; ineligible cards use the neutral hatch chip and `color.fg.muted` (cab `#a3a8b2` on `#16171a` = **7.51:1**) — dimmed but never below AA, and never below the ineligibility *text*, which stays at full `color.fg`.

**Targets.** Claim 72px; all else 56px, 12px separation.

**Motion.** #9 toast equivalent (instant), #12 expand (instant).

| State | Specification |
|---|---|
| **Default** | Two groups of shift cards with claim actions and eligibility stated per card. |
| **Loading** | Group headers render, skeleton cards beneath with `busy`. Polite `"Loading open shifts."` → `"{n} shifts, {m} you're qualified for."` |
| **Empty** | Nothing open: `"No open shifts right now. Every shift is covered."` — a good empty; action `See the full schedule`. Filtered to nothing: `"No shifts match your filters."` + `Clear filters`. Qualified group empty but others open: the group renders with `"None you're qualified for right now."` and the other group follows — the group is not hidden. |
| **Error** | `"We couldn't load open shifts."` vs `"The shift request was rejected by the server."` + 56px `Retry`; filters survive. |
| **Partial** | Shifts load, qualification checks fail: cards render with `"We couldn't check your qualifications for this shift — you may be turned down after claiming."` and `Claim shift` stays enabled. Polite: `"Qualification checks couldn't run."` The uncertainty is stated rather than resolved silently in either direction. |
| **Offline** | Banner carrying the §3.4 #6 sentence verbatim: `"You're offline. You can see the schedule, but you can't claim a shift — someone else may take it, and we can't hold it for you."` `Claim shift` is disabled with that exact hint. Works: browsing the cached list with `"As of {time}"`. Queued: nothing. |
| **No permission** | **Cannot occur** — every member may see and claim open shifts (F2.9). The adjacent case is a member whose status is `leave of absence`: cards render, `Claim shift` is disabled, and the hint reads `"You're on leave of absence, so you can't claim shifts. Talk to the chief."` — visible and explained, never hidden. |

### N7 — Shift detail & claim

**Container model & headings.** Root label `"Shift detail"`. Header: `"{Shift name}, {date}"`. Section headers: `"Section: When and where"`, `"Section: Positions"`, `"Section: Who's on it"`, `"Section: Your eligibility"`.

**Operation.** One 72px primary button whose label and accessible name reflect state: `Claim shift` / `Give back this shift` / `Request a swap`. `Positions` is a list, each row naming the position, the qual it needs, and whether it is filled and by whom. Back exits normally.

**Focus.** Claim / give back: §3.4; give back is treated as a confirm-required action (another member's plans depend on it) with the dialog naming the shift and date; focus to dialog header, on confirm focus returns to the button (now `Claim shift`), polite `"You gave back {shift name}, {date}. It's open again."` Swap request: sheet, focus to sheet header, on send focus returns to the button, polite `"Swap request sent to {name}."`

**Narration.** On load: `"{Shift name}, {day} {date}, {start} to {end}. {n} of {m} positions filled. {Your status}."` Position rows read: position name → required qual → `"Filled by {name}"` or `"Open"`. Your eligibility reads as a full sentence naming the blocking qual and its expiry date when blocked.

**Contrast.** Per §1.2; filled/open positions use the §1.8 filled-square / hollow-square glyph pair plus text, never fill colour alone.

**Targets.** Primary 72px; rows 56px.

**Motion.** #12 expand (instant), #9 toast (instant).

| State | Specification |
|---|---|
| **Default** | Times, positions, who's on it, your eligibility, one primary action. |
| **Loading** | Shift name, date, and times come from the list payload and render immediately. Positions and roster show 56px skeletons with `busy`. Polite `"Loading shift detail."` → `"{n} of {m} positions filled."` |
| **Empty** | No one on it yet: `"No one has claimed a position on this shift yet."` — for an eligible member the primary action already exists above, so no second action is added. No positions defined: `"This shift doesn't list any required positions."` |
| **Error** | `"We couldn't load this shift."` vs `"The shift request was rejected by the server."` + 56px `Retry`. |
| **Partial** | Positions load, the roster of who's on it fails: positions render, the roster section shows the placeholder + `Retry`. Polite: `"We couldn't load who's on this shift. The positions are correct."` |
| **Offline** | Banner with the §3.4 #6 sentence. Works: reading the cached shift with `"As of {time}"`. Queued: nothing. Unavailable: claim, give back, swap — all disabled with the atomicity reason. |
| **No permission** | **Cannot occur** for viewing. Editing the shift definition is officer-only and is not on this screen at all for a member; for an officer without the role it renders as a disabled `Edit shift` with `"Only officers and the chief can change a shift."` |

### N8 — Apparatus list

**Container model & headings.** Root label `"Apparatus"`. Header: `"Apparatus"`. Section headers: `"Section: Out of service"` (first), `"Section: In service"`, `"Section: Checks due today"`.

**Operation.** Cards per apparatus with a 72px `Start check` primary and a 56px `Open` secondary. `Place out of service` is on the apparatus detail path, not here, and is **never** a swipe action (§1.6). 56px `Refresh` in the header; pull-to-refresh is an accelerator.

**Focus.** `Start check`: navigates to N9 with focus on N9's header. `Open`: navigates to the apparatus detail with focus on its header. Refresh: focus stays, polite `"{n} apparatus. {m} out of service. {k} checks due today."`

**Narration.** On load, the counts sentence above. Card reading order: unit ID → type → status chip text → `"Last checked {date} by {name}"` → `"{n} open defects"` → the actions. Out-of-service cards read their reason: `"Out of service: {reason}."`

**Contrast.** §1.8 status treatments; out-of-service uses the ▲ glyph + 45° hatch + text, so it survives forced-colours and monochrome. Cab `#ff6b5e` on `#0b0b0d` = **7.04:1**.

**Targets.** `Start check` 72px, `Open` 56px, 12px separation, 56px card rows.

**Motion.** #11 sync spinner (static text + counter), #12 expand (instant).

| State | Specification |
|---|---|
| **Default** | Out-of-service first, then in-service apparatus, then checks due today. |
| **Loading** | Section headers render, skeleton cards beneath, `busy`. Polite `"Loading apparatus."` → the counts sentence. |
| **Empty** | No apparatus: `"No apparatus registered yet. The chief or the apparatus officer adds them."` — no action for a member. Out-of-service empty: the section renders with `"Nothing is out of service."` — a good empty and one that must be *stated*, not omitted, because an absent section reads as missing data. Checks due empty: `"No checks due today."` |
| **Error** | `"We couldn't load the apparatus list."` vs `"The apparatus request was rejected by the server."` + 56px `Retry`. |
| **Partial** | The list loads; per-apparatus defect counts and check-due dates come from a separate aggregate and can fail. Cards render with those lines reading `"Check status unavailable"` + warning glyph + in-card `Retry`. Polite. **Exception:** if the out-of-service flag itself cannot be read, that section announces assertively (permitted class 2) `"We can't confirm what's out of service. Check the board before you roll."` |
| **Offline** | Banner. Works: the cached list stamped `"As of {time}"`, and **starting and completing a check** (§3.2) — this is the primary offline workflow in the product. Queued: check results and defects. Unavailable: `Refresh` only. |
| **No permission** | Every member sees the list and may start a check (F4.2 is a member workflow, not an officer one). `Open` leading to the officer-only sections renders the in-place denial there, not here. A user with no apparatus access at all gets the full denied panel naming the apparatus officer. |

### N9 — Truck check run

A 90-second, gloved, offline workflow (N4.2, N3.4, N3.5). Every decision below is subordinate to the budget, and none of them is allowed to buy speed with an accessibility cost.

**Container model & headings.** Root label `"{Apparatus} check"`. Header: `"{Apparatus} check"`. Section headers per compartment/group: `"Section: {group name}"`. A persistent progress region (`accessibilityLiveRegion="polite"` on Android, announced on change on iOS) carries `"{n} of {total} checked"`.

**Operation.** One item per row, never a grid (§1.11 flagged case (c)). Each row: item name, then a 56px segmented pass/fail pair exposed as `radiogroup` with two `radio` children (`Pass`, `Fail`) and `accessibilityState={{checked}}`. Failing opens N10. A 56px `Add a note` per row. Bottom bar: 72px `Finish check`, always reachable, never scrolled out of reach. Back gesture prompts `"Leave this check? Everything you've checked is saved on this phone."` with `Leave` / `Keep checking`.

**Focus.** Auto-advance on pass, per §3.2 #2 — the only auto-advance in the product, announced every time, and disableable in N15 (`Don't advance automatically`). No auto-advance on fail (§3.2 #3). Opening N10: modal, focus to its header, progress preserved; on return focus goes to the failed item, not the top (§3.2 #6). `Finish check`: on success, focus to the confirmation screen header; on offline completion, the same, with the §3.2 #9 wording.

**Narration.** On start, §3.2 #1. Each pass/fail announces per §3.2 #2/#3. The progress region announces at most once per 3 seconds, coalescing. Row reading order: item name → its note if any → the pass/fail control with its current state. **Item names are never truncated** (§1.11) — a truncated item name on a check sheet is a compliance defect.

**Contrast.** `Pass` selected: cab `#35a862` fill with `#0b0b0d` label = **6.49:1**. `Fail` selected: cab `#e8503f` fill with `#0b0b0d` label = **5.29:1**. Unselected: outline with `color.border.strong` `#9aa0aa` at **7.48:1** and `color.fg` label at **13.79:1**. Selection is additionally carried by the ✔ / ✕ glyph and by `accessibilityState`, never by fill alone.

**Targets.** Pass/fail controls 56 × 56 each with 12px between them and 12px to the row edge; `Finish check` 72px full-width. This is the screen the 56px glove floor exists for.

**Motion.** #8 progress (stepped bar + `"{n} of {total} checked"` text, which is authoritative), #11 sync (static text + counter), #12 expand (instant).

| State | Specification |
|---|---|
| **Default** | A grouped list of check items with pass/fail per item, live progress, and a finish action. |
| **Loading** | The sheet definition is cached on the device after first use, so the normal case has **no loading state**. First-ever load of a sheet: skeleton rows with `busy`, polite `"Loading the {apparatus} check sheet."` → `"{n} items."` |
| **Empty** | No sheet configured for this apparatus: `"There's no check sheet for {apparatus} yet, so there's nothing to check. The apparatus officer sets one up."` — no action for a member; for the apparatus officer, `Create a check sheet` → W15. |
| **Error** | Sheet fetch fails on first use: `"We couldn't load the check sheet."` vs `"The check sheet request was rejected by the server."` + 56px `Retry`. **A check already in progress is never lost to a fetch error** — the in-progress state is local and the error is shown above it, not in place of it. |
| **Partial** | The sheet loads but a group's items fail: loaded groups are checkable; the failed group shows the placeholder + `Retry {group}` and is excluded from the progress denominator, with the progress text reading `"{n} of {total} checked, {m} items couldn't load"` so the count is never silently wrong. `Finish check` stays enabled and the confirmation states the incomplete group by name. |
| **Offline** | The expected state, not an exception. Banner: `"You're offline. The check works normally — it saves here and sends when you're back."` Works: everything. Queued: the whole check and any defects. Unavailable: nothing. Every save announces `"Saved on this device."` at most once per 10 seconds. |
| **No permission** | **Cannot occur** — any member may run a check (F4.2). The adjacent case is a check sheet restricted to a qualification the member lacks (e.g. an aerial check): the check opens read-only with the banner `"You can see this check sheet, but you need the {qual} qualification to complete it. Ask an officer."` and the pass/fail controls disabled with that hint — visible and explained, never a blank screen. |

### N10 — Defect report with photo

**Container model & headings.** Root label `"Report a defect"`. Header: `"Report a defect on {item}"`. Section headers: `"Section: What's wrong"`, `"Section: Photos"`, `"Section: Severity"`.

**Operation.** Six fields → **error summary required** (§1.10). Description is a multi-line `TextInput` with a visible label and a persistent hint. Severity is a 56px `radiogroup` (`Note` / `Needs attention` / `Out of service now`). Photos: a 72px `Take a photo` and a 56px `Choose from library`, each captured photo becoming a 56px row with a `Remove` button and a **required** `accessibilityLabel` field — the caption is the photo's text alternative and the form will not submit with a photo and no caption. This is a 1.1.1 obligation and it is enforced, not suggested; the caption field's label is `"Describe what the photo shows"` and its hint explains why (`"So the apparatus officer can read this without opening the photo."`).

**Focus.** Camera returning: focus to the new photo row's caption field, polite `"Photo added. {n} of 3. Describe what it shows."` `Remove` photo: reversible → immediate with a 10s focusable `Undo`; focus goes to the next photo row, or to `Take a photo` if none remain. Validation failure on submit: the error summary (`role="alert"` equivalent, `setAccessibilityFocus`). Submit success: modal closes, focus returns to the failed check item in N9 (§3.2 #6). Choosing `Out of service now`: an inline confirm appears beneath the radio with the consequence text, and focus moves to it — this is the one field on the screen whose selection has an operational effect beyond the report.

**Narration.** On open, §3.2 #4. Severity options read their consequence: `"Out of service now — {apparatus} is pulled from riding assignments and the alert roster immediately."` Submit button: `Save defect`.

**Contrast.** Fields on `surface.raised` `#1f2126`: label `#d6d8dd` **11.29:1**, placeholder `#a3a8b2` **6.75:1**, border `#9aa0aa` **6.12:1**, error text and border `#ff6b5e` **5.77:1**. Day equivalents per §1.2.

**Targets.** 56px minimum on every control; `Take a photo` 72px; radio options 56px tall, full-width, 12px apart.

**Motion.** #8 upload progress (stepped + `"{n}%"` text), #9 toast (instant).

| State | Specification |
|---|---|
| **Default** | Description, photos with captions, severity, save. |
| **Loading** | Only on save and on photo upload. Save: button → `Saving…`, `busy` on the form, button stays focusable. Photo upload: per-photo stepped progress with `"{n}% uploaded"` text; **the form remains submittable while photos upload** — a photo that has not finished uploading is queued with the defect, never blocking. |
| **Empty** | No photos attached is a legitimate state, not an error: the photos section reads `"No photos. A photo helps the apparatus officer see the problem, but it's not required."` The form has no other empty state — it is a blank form by nature. |
| **Error** | Save fails: `"We couldn't send this defect."` (unreachable) vs `"The server rejected this defect: {reason}."` (rejected), both + `Retry`, both **assertive** (permitted class 4/5 when it happens mid-submit). **Nothing typed and no photo is ever discarded**, and the message says `"Everything you wrote is still here."` |
| **Partial** | The defect saves but one or more photos fail to upload: the defect is recorded and the photo rows show `"Photo didn't upload"` + warning glyph + `Retry photo`. Polite: `"Defect saved. {n} photos couldn't upload and are still on this phone. They'll retry automatically."` |
| **Offline** | Banner. Works: the whole form including camera capture. Queued: the defect and its photos, announced `"Saved on this device. It will send when you're back online."` Unavailable: nothing — but if severity is `Out of service now`, the confirmation adds the mandatory line `"Tell the officer by radio as well — this hasn't reached the server yet."` (matching W11's offline OOS decision). |
| **No permission** | **Cannot occur** — any member running a check may report a defect (F4.3). `Out of service now` is the exception: members without the apparatus-officer or chief role see that option disabled with the hint `"Only the apparatus officer and the chief can pull an apparatus out of service. Choose 'Needs attention' and tell an officer."` — disabled with a route forward, never hidden. |

### N11 — My profile & contact

**Container model & headings.** Root label `"Your profile"`. Header: `"Your profile"`. Section headers: `"Section: Contact details"`, `"Section: Alert contacts"`, `"Section: Department record"`.

**Operation.** `Contact details` is an editable form (name, email, mobile, secondary phone, address) → six-plus fields, **error summary required**. `Alert contacts` shows the phone number SMS and voice fallback will use, with a 56px `Change` — this is the field that silently breaks the alert path when wrong, so it carries a persistent hint `"Alerts by text and voice go to this number."` and its own `Test my alert path` link → N4. `Department record` (rank, status, agency ID, join date) is read-only text with `"Only an administrator can change this."` on each field's hint.

**Focus.** Save: focus stays on `Save changes`, polite `"Changes saved."` Validation failure: error summary. Changing the alert phone number: an inline confirm appears with `"Alerts by text and voice will go to {new number} from now on. Test your alert path after you save."` and focus moves to it; after saving, polite `"Saved. Your alert number is {number}. Test your alert path now?"` with a focusable `Test now`.

**Narration.** Read-only fields are announced as read-only via `accessibilityState={{disabled:true}}` plus the hint — a read-only field that reads as editable is a trap.

**Contrast.** Form contrast per N10. Read-only fields use `color.fg.muted` on `surface` (cab **7.51:1**, day **7.20:1**) — muted but well above AA, because a member must be able to read their own record.

**Targets.** 56px controls, 12px separation.

**Motion.** #9 toast (instant), #12 expand (instant).

| State | Specification |
|---|---|
| **Default** | Editable contact details, alert contacts with a test link, read-only department record. |
| **Loading** | Fields render as 56px skeletons with `busy`; labels render for real immediately so structure is announced. Polite `"Loading your profile."` → `"Profile loaded."` |
| **Empty** | Missing alert phone number — the dangerous empty: the `Alert contacts` section renders with the warning glyph and `"No phone number for text and voice alerts. If push notifications fail, nothing will reach you."` + a 72px `Add your phone number`. This empty state is warning-styled and is announced **assertively** on entry (permitted class 2). Other fields empty simply show their placeholder. |
| **Error** | `"We couldn't load your profile."` vs `"The profile request was rejected by the server."` + `Retry`. Unsaved edits survive. |
| **Partial** | Contact details load, department record fails (a separate service): editable sections work; the record section shows the placeholder + `Retry`. Polite. |
| **Offline** | Banner. Works: viewing cached values with `"As of {time}"`, and editing. Queued: contact edits, announced `"Saved on this device. It will send when you're back online."` — **with the extra line for the alert phone number specifically:** `"Your alert number hasn't changed on the server yet. Alerts still go to {old number}."` Unavailable: `Test my alert path` (N4's offline rule). |
| **No permission** | **Cannot occur** — every member owns their profile (F2.6). Editing *another* member's profile is not on this screen; that is W6. |

### N12 — My certifications

**Container model & headings.** Root label `"Your certifications"`. Header: `"Your certifications"`. Section headers: `"Section: Expiring soon"`, `"Section: Current"`, `"Section: Expired"`. Expired is a section, not a filter — a member must not have to find it.

**Operation.** Rows with a 56px `View` (opens the attachment) and a 56px `Ask about renewing` (messages the training officer). No editing — members do not renew their own certifications.

**Focus.** `View`: opens a full-screen viewer, focus to its header, back returns to the row. `Ask about renewing`: sends and the button becomes `Asked {date}`, disabled for 7 days with the reason; focus stays; polite `"The training officer has been asked about renewing {certification}."`

**Narration.** On load: `"{n} certifications. {m} expire in the next 90 days. {k} have expired."` Row order: certification name → issuing authority → `"Expires {absolute date}, in {n} days"` or `"Expired {absolute date}, {n} days ago"` → the qualification it grants → status chip text. **Expiry always carries both the absolute date and the relative phrase** (as W9).

**Contrast.** §1.8 treatments; expired uses ▲ + double 3px border + text (cab `#ff6b5e` **7.04:1**), due-soon uses ◔ + solid border + text (cab `#ffc247` **12.23:1**).

**Targets.** 56px rows and controls.

**Motion.** #12 expand (instant).

| State | Specification |
|---|---|
| **Default** | Three sections: expiring soon, current, expired. |
| **Loading** | Section headers render, skeleton rows beneath, `busy`. Polite `"Loading your certifications."` → the counts sentence. |
| **Empty** | None recorded: `"No certifications on your record. That may mean the training officer hasn't added them yet — ask if you hold certifications that aren't here."` + `Ask the training officer`. The framing matters: an empty certification list is more often a data gap than a real absence, and telling the member that prevents a silent eligibility problem. Per-section empty: each renders `"None"` rather than being hidden. |
| **Error** | `"We couldn't load your certifications."` vs `"The request was rejected by the server."` + `Retry`. |
| **Partial** | Certifications load, attachments fail: rows render, `View` disabled with `"The attachment couldn't load."` + in-row `Retry`. Polite. |
| **Offline** | Banner. Works: the cached list with `"As of {time}"`. Queued: nothing (read-only screen). Unavailable: `View` (attachments are not cached) and `Ask about renewing` — disabled with `"Needs a connection."` |
| **No permission** | **Cannot occur** — every member sees their own certifications. Viewing another member's is W6/W9 and is not reachable from this screen. |

### N13 — My LOSAP points & attendance

**Container model & headings.** Root label `"Your points and attendance"`. Header: `"Your points"`. Section headers: `"Section: This year"`, `"Section: How you earn points"`, `"Section: Your attendance"`.

**Operation.** `This year` shows the running total as large text with a progress representation. `How you earn points` is a disclosure list of the department's point rules. `Your attendance` is a paginated list with a `Load more` button (56px), never infinite scroll — infinite scroll strands screen-reader and keyboard users below a list that never ends.

**Focus.** `Load more`: focus moves to the first newly-loaded row (`setAccessibilityFocus`), polite `"{n} more loaded. {total} shown."` Disclosure: focus stays on the trigger, `accessibilityState={{expanded}}` flips.

**Narration.** `This year` reads as a sentence before any visual: `"{n} points this year. {m} needed for the year-end award. {k} to go."` If no target is configured, the third clause is omitted rather than shown as zero. Attendance rows read: date → activity type → `"{n} points"` → `"Recorded by {name}"`.

**Contrast.** The points total is `type.h1` in `color.fg` (cab **13.79:1**). The progress representation is **not** the information channel — the sentence is; the bar carries `accessibilityRole="progressbar"` with `accessibilityValue={{min, max, now, text}}` where `text` is the same sentence.

**Targets.** 56px rows and controls.

**Motion.** #8 progress (stepped + text), #12 expand (instant).

| State | Specification |
|---|---|
| **Default** | Year total, point rules, paginated attendance history. |
| **Loading** | The total shows a skeleton; the rules list renders from cache immediately. Polite `"Loading your points."` → the total sentence. |
| **Empty** | No points yet: `"No points yet this year. You earn points by responding to calls, going to drills, and taking duty shifts."` + `See open shifts`. No attendance: `"No attendance recorded for you yet."` No point rules configured department-wide: `"Your department hasn't set up point rules, so nothing is being counted yet."` — no member action; it names the chief. |
| **Error** | `"We couldn't load your points."` vs `"The request was rejected by the server."` + `Retry`. |
| **Partial** | Attendance loads, the computed total fails: history renders; the total section shows the placeholder + `Retry`. Polite: `"Your point total couldn't load. Your attendance history is complete."` The reverse (total loads, history fails) renders the total and the placeholder for history. |
| **Offline** | Banner. Works: cached total and first page with `"As of {time}"`. Queued: nothing (read-only). Unavailable: `Load more` — disabled with `"Needs a connection."` |
| **No permission** | **Cannot occur** — every member sees their own points (F2.4 requires per-member visibility). Other members' points are W8 and are not reachable here. |

### N14 — Sign in

The only authentication screen on the native surface, reached once, at install. Its accessibility obligation is the same as W1's plus one: the member must leave it understanding they will not see it again.

**Container model & headings.** Root label `"Sign in"`. Header: `"Sign in to Boxalarm"`. No tab bar (the member is not authenticated).

**Operation.** Email, password, a 56px `Show password` toggle (`accessibilityState={{checked}}`), a 72px `Sign in`, a 56px `I forgot my password`, and a 56px `Call the department` link with the number in its accessible name. `autoComplete="username"` / `"password"`, `textContentType` set on iOS so Keychain and password managers work — a password manager is an accessibility affordance for members who cannot reliably type a long password.

**Focus.** On mount: focus to the header (not the email field — auto-focusing a field opens the keyboard over the explanatory text). On failure: `setAccessibilityFocus` to the error region. On success: the app's Home screen (N5) with focus on its header. Biometric unlock is offered **as a convenience for re-opening a locked device, never as a session gate** — and it is optional, skippable, and its absence never blocks the app.

**Narration.** Reading order: header → the explainer `"You'll stay signed in. Boxalarm never signs you out, so you'll never see a login screen when you're called out."` → email → password → toggle → sign in → forgot → call. That explainer is mandatory content (as W1).

**Contrast.** Fields per N10. `Sign in` cab `#35a862` / `#0b0b0d` = **6.49:1**.

**Targets.** `Sign in` 72px full-width; all else 56px.

**Motion.** None beyond #6 sheet transitions (cross-fade under reduced motion).

| State | Specification |
|---|---|
| **Default** | Two fields, one primary button, recovery, and the department phone number. |
| **Loading** | On submit only: button → `Signing in…`, `busy` on the form, button stays focusable. Nothing under 400ms is announced. |
| **Empty** | **Cannot occur** — a sign-in form has no data to be empty of. |
| **Error** | Credentials rejected: `"That email and password don't match. Check them, or use 'I forgot my password'."` Server unreachable: `"We can't reach Boxalarm. Check your signal. If there's a call right now, listen to your radio — the department's tone-out paging is still running."` The second names the N1.9 fallback. Both `setAccessibilityFocus` to the error, announced assertively (permitted class 4 when mid-submit). **Typed email is never cleared.** |
| **Partial** | **Cannot occur** — one endpoint, no partial data. |
| **Offline** | Banner: `"You're offline. You can't sign in until you have a connection. If you were already signed in on this phone, close this and open Boxalarm — you won't be asked again."` `Sign in` disabled with that reason. |
| **No permission** | **Cannot occur on entry** — sign-in is public. Valid credentials for a deactivated member: the form is replaced by the denied panel `"Your membership is not active"` + `"Your account is marked {status}. You won't be alerted. The chief or an administrator can reactivate it. Call the department at {number}."` — focused and announced politely. Never a bare 403. |

### N15 — Notifications & alert-path settings

The screen that decides whether the product works. Every control here changes whether a member gets paged, and the accessibility obligation is that no control's consequence is left to inference.

**Container model & headings.** Root label `"Notifications and alerts"`. Header: `"Notifications and alerts"`. Section headers: `"Section: Critical alerts"`, `"Section: Alert sound and vibration"`, `"Section: Accessibility"`, `"Section: Other notifications"`, `"Section: Your alert path"`.

**Operation.** Eight-plus controls → **error summary required** where a save can fail. `Critical alerts` shows the OS permission state as text and, when not granted, a 72px `Open phone settings` that deep-links. `Alert sound and vibration` offers a sound choice (`radiogroup`, each option with a 56px `Play` preview) and a vibration-pattern choice with a `Test vibration` button — both are alternative channels for members who cannot rely on the other, and both are individually testable. `Accessibility` holds: `Palette` (`Cab` / `Day` / `Match my device`), `Reduce motion` (`Match my device` / `Always reduce` / `Never reduce`), `Text size` (100/125/150/200%), `Don't advance automatically` (the N9 auto-advance switch, §3.2 #2), and `Extra-large alert buttons` (raises the N1/N2 floor from 72px to 88px). `Your alert path` shows the last self-test with a 72px `Test now` → N4.

**Focus.** Every switch: focus stays, `accessibilityState={{checked}}` flips, and the **consequence** is announced politely, never a bare "on/off": `"Critical alerts on. Boxalarm will page you through silent mode and Do Not Disturb."` / `"Critical alerts off. You will not be paged when your phone is silenced."` Returning from OS settings: the permission state is re-read on foreground and, if it changed, announced politely with focus unmoved. Save failure: error summary, focused.

**Narration.** `Critical alerts` reads its state first and in consequence terms, not permission terms: `"Critical alerts are on. You'll be paged even when your phone is silent."` or `"Critical alerts are off. You will not be paged when your phone is silent — this is the most common reason members miss a call."` Reading order puts `Critical alerts` first for that reason.

**Contrast.** A disabled critical-alert state uses the ▲ glyph + double border + text (cab `#ff6b5e` **7.04:1**) — it is treated as a fault, not a preference, and looks like one in monochrome and forced-colours.

**Targets.** `Open phone settings` and `Test now` 72px; all switches 56px with 12px separation.

**Motion.** #11 (static text + counter), #12 expand (instant).

| State | Specification |
|---|---|
| **Default** | Five sections; critical-alert status first; every control states its consequence. |
| **Loading** | Local preferences render instantly and **never show a loading state** — a member must be able to reach their own accessibility and alert settings with no network. Only `Your alert path` (the last test result, server-side) skeletons, with `busy`. |
| **Empty** | Never tested: `Your alert path` reads `"You haven't tested your alert path. A test proves you'd actually get called out."` + a 72px `Test now`. No other section can be empty. |
| **Error** | Saving a server-side preference fails: `"We couldn't save that."` vs `"The server rejected that change."` + `Retry`; the control **reverts visibly** and the revert is announced, because a switch that looks changed but is not is the worst possible failure on this screen: `"{Setting} was not saved and is still {previous state}."` **Assertive** when the setting is `Critical alerts` or `Alert sound`. |
| **Partial** | Local settings load, the server-side alert-path result fails: local sections work; `Your alert path` shows the placeholder + `Retry`. Polite, plus the consequence: `"We can't show your last alert-path test."` |
| **Offline** | Banner. Works: every local setting — palette, reduce motion, text size, auto-advance, extra-large buttons, sound, vibration — all fully. Queued: server-side preference changes, announced `"Saved on this phone. It will send when you're back online."` Unavailable: `Test now` (N4's rule) and reading the last test result. The `Critical alerts` OS permission state is local and remains accurate offline. |
| **No permission** | **Cannot occur** — every member owns their own notification settings. The OS-level permission denial is not a Boxalarm permission state: it is handled in `Critical alerts` above, as a fault with a 72px route to the fix, and it is announced on every entry to this screen while it persists. |

---

## 6. Coverage matrix

30 screens × 7 states = **210 screen×state cells**, each specified above. Cells resolved as "cannot occur" carry a stated reason and are counted as specified.

| Surface | Screens | Cells | "Cannot occur" cells (with reason) |
|---|---|---|---|
| Web W1–W15 | 15 | 105 | W1 empty, W1 partial (2) |
| Native N1–N15 | 15 | 105 | N1 no-permission, N4 no-permission (partial — own path), N5 no-permission, N7 no-permission, N9 no-permission, N11 no-permission, N12 no-permission, N13 no-permission, N14 empty, N14 partial, N14 no-permission, N15 no-permission (12) |
| **Total** | **30** | **210** | **14** |

Each of the 14 "cannot occur" cells states its reason and, where an adjacent real case exists (a deactivated member, a removed role, an OS-level permission denial), specifies that case in full instead. The remaining 196 cells each carry a distinct decision — never "same as above" and never a reference to another cell.

**Transitions with a named focus destination:** §1.6 specifies 20 global transition classes; §3 specifies 34 flow-level transitions; §4 and §5 specify per-screen focus destinations for dialog open/close, deletion, insertion, validation failure, async completion, step change, and route change on every screen. No transition in this document ends without a named destination.

**Asynchronous outcomes with an announcement decision:** every loading, error, partial, offline, sync, submission, escalation, and background-completion outcome in §3, §4, and §5 carries an explicit announcement string and a `polite` / `assertive` decision. Assertive is used in exactly the five permitted classes enumerated in §1.5 and nowhere else.

**Animations with a reduced-motion alternative:** 15 animations in §1.9, each with a named alternative; 4 of the 15 are removals, and each of those 4 is justified by the animation carrying no meaning.

---

## 7. Conflicts and resolutions — for PRD section 10

Every conflict between the "Command console" brand direction, the product's stated behaviour, and WCAG 2.1 AA. **AA wins in every case.** `audit-brand-conformance` and `audit-accessibility` must describe these same resolutions.

| # | Conflicting requirement | Criterion | Resolution | Smallest adjustment achieving compliance |
|---|---|---|---|---|
| 1 | Safety orange `#ff6b00` as status text on the `day` palette — the brand's signature hue | 1.4.3 Contrast (Minimum) | Rejected for text on `day`. `#ff6b00` on `#ffffff` is **2.86:1** and fails even the large-text 3:1 floor. | Foreground darkened to `#8a4a00` (**6.86:1**) for `day` status text. The pure hue is retained **only** as a fill behind `#0b0b0d`/`#ffffff` text and as a non-text indicator ≥3:1, never as text on the page ground. |
| 2 | Safety red `#ff3b30` as status text on the `day` palette | 1.4.3 | Rejected for body text on `day` (**3.55:1**). | Darkened to `#c02418` (**5.99:1**) for `day`. `#ff3b30` remains permitted on `cab` (**5.54:1**) and as large text ≥24px on `day` only where the design explicitly declares large-text usage; no such usage is declared, so the hue is not used as text on `day` at all. |
| 3 | Near-black ground with dark chrome — the "purpose-built equipment" look wants low-contrast surfaces and hairline borders | 1.4.11 Non-text Contrast | Surface elevation alone cannot carry a control boundary. `surface` vs `bg` is **1.10:1**. | Every card, input, and control carries an explicit 1px `color.border` at **3.95:1** (`cab` `#6b7078`) / **4.25:1** (`day` `#767b85`). Elevation is decorative; the border is the boundary. |
| 4 | A dark-first console aesthetic implies `day` is a lighter tint of `cab` | N7.3 + 1.4.3 | Rejected. Two independently-computed palettes, neither derived from the other, both AA at every pairing in §1.2. | `day` foregrounds are darkened independently rather than by algorithmic inversion; the two palettes share only token *names*, never values. |
| 5 | Safety orange/red as the sole status encoding — "colour reserved strictly for status" reads as colour *being* the status | 1.4.1 Use of Colour | Rejected. | Every status carries hue + glyph + border style + text (§1.8). Every screen is re-read in `forced-colors: active` and loses no information. |
| 6 | Categorical chart series distinguished by the brand's status hues | 1.4.1, 1.4.11 | Adjacent series contrast at ~1.1:1 and hue is doing the work. | Series carry a fill pattern, a direct label, and a 2px page-ground separator; every chart has a `Show as table` toggle in the tab order. |
| 7 | 56px touch targets everywhere (brand direction) vs. dense office tables at `xl` | 2.5.5 / 2.5.8 Target Size | Both honoured, per posture. | Field posture 56px, alert path 72px, office posture 44px with 8px separation — never below 44px, and dense tables collapse to cards below `lg` rather than shrinking targets. |
| 8 | 32px address type on the alert path (brand direction) vs. OS text scaling to 200% | 1.4.4 Resize Text | No conflict once `allowFontScaling` is left on; the layout is built for the scaled case. | The N1 address container is height-flexible and scrolls internally; the address is never truncated and `allowFontScaling` is never disabled anywhere in the app. |
| 9 | An arriving alert should be visually unmissable — the aesthetic pull toward a flashing or strobing alert screen | 2.3.1 Three Flashes | Rejected outright. | A steady high-contrast treatment plus sound, haptics, and persistent text. Nothing in the product flashes more than 3 times per second. The one attention loop that survives (the active-call bar) is replaced by a static bar with a text timer under reduced motion. |
| 10 | An arriving alert should be perceivable without animation | 1.4.2 / 2.2.2 / product requirement | Motion is never the arrival channel. | Arrival is carried by four independent channels — critical-alert sound, 3-pulse haptic, assertive announcement, persistent on-screen text — any one of which suffices. |
| 11 | "Terse, operational" voice vs. errors that must state what happened and what to do | 3.3.1 / 3.3.3 + discovery Round 5 | Terseness yields where it would cost actionability. | Every error is one short sentence of cause plus one of action, and **cannot reach the server** is worded differently from **the server rejected this** on every screen; error codes go in a collapsed `Technical details`. |
| 12 | Hover-revealed row actions (the dense console look) | 2.1.1 Keyboard, 1.4.13 | Rejected as an existence mechanism. | Row actions are always in the DOM and always focusable; hover changes opacity only, and focus forces opacity to 1.0. |
| 13 | Drag-to-reorder riding assignments and swipe-to-claim shifts | 2.1.1, 2.5.1, 2.5.7 | Retained only as accelerators. | Every one has a button equivalent and a keyboard equivalent (§1.6 table), and each is also registered as an `accessibilityAction` so it appears in the VoiceOver/TalkBack rotor. |
| 14 | Slide-to-confirm for placing an apparatus out of service | 2.5.1, 2.5.7 | Rejected as an affordance; it does not appear in the product. | Two-step button plus a confirm dialog naming the apparatus and the consequence. |
| 15 | Single-key shortcuts (`/`, `g a`, `?`) for the office posture | 2.1.4 Character Key Shortcuts | Retained with the required mitigations. | Suppressed inside text fields, individually disableable, and globally disableable in `/admin` → Accessibility. No function depends on a shortcut. |
| 16 | Auto-advance in the truck check, driven by the 90-second budget | 3.2.1 On Focus / 3.2.2 On Input | Retained, with mitigations, because the budget is a product requirement. | It is the only auto-advance in the product; it is announced on every advance so it is never surprising; and `Don't advance automatically` in N15 turns it off permanently. |
| 17 | N1 is a focus trap that `Escape` does not exit | 2.1.2 No Keyboard Trap | Compliant, not a trap: three always-available exits. | The three response buttons and the OS back gesture all leave the screen; the notification remains, so leaving loses nothing. Documented here because it reads like a trap and must not be "fixed" into a dismissible dialog. |
| 18 | Members without a capable smartphone cannot be alerted (PRD §11 assumption 6) | Beyond WCAG — an access gap, not a criterion | Recorded, not resolved by design. | The N1.9 parallel tone-out run is the compensating control and is therefore not optional. This specification cannot close the gap; it flags that removing N1.9 would strand these members entirely. |
| 19 | Screen-reader narration cannot be the only alert channel for a driving or gloved member | Beyond WCAG — a context-of-use obligation | Four parallel channels (conflict 10). | No announcement in this product is load-bearing alone on the alert path. |
| 20 | A response from a member whose role was removed between fan-out and open (N1 no-permission) | 3.3.4 / operational safety | Accept the response; reconcile on W4. | Refusing a response at 03:00 from someone at the station is a worse failure than a stale roster entry. Recorded as a deliberate authorization decision, not an oversight. |
| 21 | Navigation items for roles the user lacks — the console aesthetic favours hiding them | 3.2.3 Consistent Navigation, 3.3.1 | Hiding rejected. | Unavailable nav items and controls are rendered `aria-disabled` with a describedby reason naming the holding role, because role-based authorization with no step-up (F9.1) makes the denied state the **only** visible authorization boundary in the product. |
| 22 | No MFA, no step-up, no session expiry (F9.1, N5.2) — the temptation to add a password prompt on export or destructive actions | Product decision, interacts with 3.3.4 | No re-authentication anywhere, including data export. | Consequence-naming confirm dialogs plus the per-invocation chief notification (N5.2) are the controls. **No password field, code entry, or biometric prompt appears in any dialog in this product.** The export confirmation announces the notification so the acting user knows the action is observed. |

---

## 8. What this specification does not cover

- **The design system's component APIs.** This document specifies behaviour and obligations; `ux-designer` owns the component inventory and composition. Where the two disagree, this document's accessibility obligations are the constraint and the component must change.
- **Copy review.** Strings here are specifications of *meaning and structure* — what must be said and in what order. `audit-content-ia` owns final wording; any rewording must preserve the cause/action split, the unreachable-vs-rejected distinction, and the consequence naming.
- **i18n key structure.** All strings above are written as full sentences with named interpolation, satisfying the no-concatenation rule; the key naming convention is `packages/i18n`'s to define, and it does not exist yet.
- **Automated verification.** No a11y tooling exists in `boxalarm-ui` today (`codebase-context.md` §7). `eslint-plugin-jsx-a11y`, `vitest-axe`, and the E2E axe suite (`sdlc:generate-e2e-tests`) are prerequisites for `audit-accessibility` to verify any of this, and their absence is a build-order gap, not an accessibility decision.









