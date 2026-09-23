# E8-S3-UI Web Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Role-filtered web AppShell with PrimaryNav for six personas, `cognito:groups` role source on web + mobile, forbidden/403 UX, Playwright persona fixtures.

**Architecture:** Shared `roles.ts` helpers; `ROUTE_TABLE` drives nav + guards; lazy placeholder pages; AppShell wraps authenticated routes.

**Tech Stack:** React 19, react-router-dom 7, oidc-client-ts, Vitest, Playwright, @axe-core/playwright, design-tokens CSS vars.

## Global Constraints

- Package scope `@boxalarm/*` (not `@fd/*`).
- No MFE.
- WCAG 2.1 AA; glove-sized targets on mobile (unchanged here).
- Server Cedar remains the real gate; UI nav filter is UX only.
- Do not implement sibling domain screens.

---

### Task 1: Role parsing from `cognito:groups`

**Files:**
- Create: `apps/web/src/auth/roles.ts`
- Create: `apps/web/src/auth/roles.test.ts`
- Modify: `apps/web/src/auth/AuthContext.tsx`
- Modify: `apps/web/src/auth/AuthContext.test.tsx`
- Modify: `apps/mobile/src/auth/AuthContext.tsx` (+ tests if present)

- [ ] Write failing tests: `cognito:groups` → roles; unknown → MEMBER; prefer groups over legacy `roles` claim
- [ ] Implement `rolesFromProfile` / shared helpers
- [ ] Wire web + mobile AuthContexts
- [ ] Run `npm test --workspace apps/web` and mobile auth tests
- [ ] Commit

### Task 2: Route table + AppShell + guards

**Files:**
- Create: `apps/web/src/routing/routeTable.ts`
- Create: `apps/web/src/routing/routeTable.test.ts`
- Create: `apps/web/src/components/AppShell.tsx`, `PrimaryNav.tsx`, `SkipToContentLink.tsx`, `LiveRegion.tsx`, `ForbiddenState.tsx`
- Create: `apps/web/src/routing/RequireAuth.tsx`, `RequireRole.tsx`
- Create: placeholder pages under `apps/web/src/pages/`
- Modify: `apps/web/src/App.tsx`, `LandingPage.tsx`

- [ ] Failing unit tests for route filtering and RequireRole
- [ ] Implement shell + lazy routes
- [ ] Landing uses cognito-derived roles for chief view
- [ ] Run unit tests + typecheck
- [ ] Commit

### Task 3: Playwright persona fixtures + E2E

**Files:**
- Create: `apps/web/tests/auth/personas.ts` (frozen §7.1 nav labels; storageState helpers deferred)
- Create: `apps/web/tests/e2e/primary-nav.spec.ts`
- Modify: `apps/web/tests/e2e/auth.spec.ts` (issue id tokens with `cognito:groups`)

- [ ] Write E2E: six personas nav exactness + forbidden URL
- [ ] Update existing auth E2E to use `cognito:groups: ['CHIEF']`
- [ ] Run `npm run test:e2e --workspace apps/web`
- [ ] Commit
