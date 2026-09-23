# E8-S3-UI — Web shell + role source fix

Status: approved by issue #85 ACs + architecture.md Frontend §§4.1, 7.1 (autonomous cloud agent; interactive brainstorming gate skipped per cloud-agent no-clarification rule). Parent: #103.

## Problem

1. Web has no AppShell / PrimaryNav — only sign-in + landing.
2. Both AuthContexts read a `roles` claim Cognito never issues; the backend authorizer uses `cognito:groups`. Every authenticated user therefore lands as MEMBER.

## Design

### Role source

- Read `cognito:groups` from the ID token / OIDC profile (array of strings).
- Map known group names case-insensitively onto `Role` (`MEMBER` | `OFFICER` | `TRAINING` | `APPARATUS` | `ADMIN` | `CHIEF`).
- Fallback: empty/unknown groups → `['MEMBER']` (same as today).
- Apply on web (`AuthContext.tsx`) and mobile (`decodeRoles`).

### Route table (architecture §7.1)

| Route | Roles |
|---|---|
| `/` | CHIEF, OFFICER |
| `/alerts/roster` | OFFICER, CHIEF |
| `/alerts/diagnostics` | OFFICER, CHIEF, ADMIN |
| `/incidents`, `/incidents/:id` | OFFICER, CHIEF |
| `/personnel`, `/personnel/:id` | OFFICER, TRAINING, ADMIN, CHIEF |
| `/certifications` | TRAINING, ADMIN |
| `/apparatus`, `/apparatus/:id` | APPARATUS, CHIEF |
| `/schedule` | OFFICER, ADMIN |
| `/reporting` | CHIEF, ADMIN, TRAINING |
| `/settings` | ADMIN |
| `/audit-log` | ADMIN, CHIEF |

Public: `/login` (alias of unauthenticated `/`), `/auth/callback`.

### Shell

- `AppShell`: skip link, `PrimaryNav` (only granted routes), `LiveRegion`, `<Outlet/>`.
- `RequireAuth` + `RequireRole`: unauthenticated → sign-in; missing role → Forbidden page (no route render).
- Placeholder page components for each route (lazy) so nav is testable before domain screens land in sibling issues.
- Landing `/` for MEMBER/TRAINING/APPARATUS/ADMIN without dashboard access: redirect to first granted route (or a minimal “no dashboard” home with nav only).

**Decision:** Members without `/` access redirect to their first granted nav item; if none (MEMBER alone), show a signed-in home with sign-out and no PrimaryNav domain links. Matches AC3 (CHIEF sees chief view) without inventing a member dashboard.

### 403 handling

- Shared `ForbiddenState` component: title, problem `detail`, `traceId`.
- Used by route guards and by feature screens when `ApiError` status is 403.

### Playwright

- `storageState` fixtures for six personas (pre-seeded OIDC user in localStorage with `cognito:groups`).
- Spec: each persona sees exactly their PrimaryNav links; typing a forbidden URL does not render that page.

## Out of scope (siblings)

- Domain screen bodies (E2-S1, E4-S1, …) — placeholders only.
- Cedar / server auth — server remains the gate; UI only filters nav/routes.
- Credential recovery (E8-S2), settings (E8-S4), audit log UI (E8-S5).

## Declared Assumptions

> Not verified in GitHub search for backend Cognito group naming.

- [ASSUMED] Cognito group names match Role enum strings (`CHIEF`, `ADMIN`, …), possibly mixed case — we normalize to uppercase.
