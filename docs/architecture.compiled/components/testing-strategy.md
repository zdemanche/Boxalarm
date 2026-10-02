# Testing Strategy

## Purpose & Boundaries
Risk-tiered test plan: Tier 0 alert path (F1, N1) with unit/contract/integration/E2E + continuous canary + chaos; Tier 1 compliance/money (F7 NERIS, F2.4 LOSAP, F2.9 shift claims, F9 auth) with contract tests elevated; Tier 2 everything else (thin E2E). Covers Playwright E2E (web + `APIRequestContext`), accessibility plan, unit coverage, CI gates, mobile/native approach.

## Interfaces
Layout `tests/{e2e,integration,pages,helpers}/` + `playwright.config.ts` (fullyParallel; forbidOnly + 2 CI retries; chromium/firefox/webkit/mobile-chrome; trace/video on first retry). Page objects `tests/pages/<name>.page.ts`; selector priority `getByRole` > `getByLabel` > `getByText` > `getByTestId`, no CSS/XPath/id. Shared `runAxeScan(page)` in `tests/helpers/axe.ts`; AxeBuilder tags `wcag2a`,`wcag2aa`,`wcag21aa`. Env var `NERIS_DEV_BASE_URL` asserted non-production at suite start (fail closed). Mandatory E2E flows: 1 dispatch->fan-out->receipt, 2 no-ack escalation exactly once, 3 duplicate dispatch -> one per tone, 3a re-tone of NOT_RESPONDING member creates `RECEIPT#...#2`, 3b tone-2/3 audience never filtered by ackStatus, 4 response->roster, 5 self-test (canary-safe), 6 channel failure isolation, 7 audit query, 7a halt/advance; Tier 1 flows 8-12.

## Data Ownership
absent — the source document does not address this.

## Events Produced
absent — the source document does not address this.

## Events Consumed
absent — the source document does not address this.

## Dependencies
internal: all services, web-console, mobile-app, infrastructure (chaos/staging). external: Playwright, @axe-core/playwright, Vitest, React Testing Library, MSW, Supertest, XCTest, JUnit/Espresso, XCUITest, DynamoDB Local/Testcontainers, NERIS dev environment, device farm (BrowserStack-equivalent, unconfirmed), chaos tool (unnamed, e.g. AWS FIS).

## Gotchas & Constraints
- Mandatory regression tests: (a) one dispatch/one member -> two distinct provider sends at T+0 (push AND sms; catches channelTier-keyed dedup); (b) member NOT_RESPONDING tone 1 receives a genuinely new send at tone 2 (catches tone-blind key); key-derivation unit test must FAIL if per-member-only or tone-less per-channel shape reappears.
- Load test must cover simulated tone-2/3 re-fan-out (same MessageGroupId).
- N1.7 chaos scoped to channel layer ONLY; N1.8/N1.9 are drills/field measurement, not CI tests.
- Coverage: new code >=80%, critical logic >=90% (alert idempotency/escalation, LOSAP rules, NERIS mapping, auth/RBAC, shift-claim atomicity, audit logging), overall >=70% aspirational; coverage drop on new code blocks merge.
- axe catches ~30-40%; manual NVDA/VoiceOver on alert receipt, response confirmation, truck check each wave is a release gate; critical/serious axe violations fail build.
- N5.2 assertions: no MFA challenge, silent refresh, idle session still authenticated, export/destructive actions 403 for non-admin and alarmed; re-auth prompt = test failure.
- NERIS: contract suite against N and N-1 schema fixtures; all integration against dev only; mocked 429 in CI, one real-429 check scheduled; never real incident data.
- N3.7 verified on real devices with app killed + battery optimization on.
- Truck check <90s asserted on realistic checklist length.
- Expensive suites (NERIS dev, chaos, full cross-browser) nightly; merge/staging/production gates defined in source; production gate requires canary healthy for bake period, N6.2 check, restore drill.
- Matrix rows owed by 2026-10-02 amendments: revocation split, multi-device partial outcomes, CAD ingress auth tests, mark-off lifecycle, new-route authz rows (not yet tabulated).
- Deterministic fixture data only; synthetic PII; fixed clock injection.

## Source Sections
Testing §1-2 (2211-2439); §3 Playwright (2443-2525); §4 a11y (2527-2564); §5 unit (2568-2594); §6 CI (2596-2622); §7 mobile (2626-2648); §8 OQ (2652-2668)
