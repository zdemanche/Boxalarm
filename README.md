# Boxalarm

Fire department operations platform. Replacement for Chief360.
Tenant zero: **a volunteer fire department, our first customer.**

> A *box alarm* is the dispatch assignment for a structure fire — the call that puts a full complement on the road.

**The bet:** the two things that actually matter — alerting that never misses, and incident reporting that isn't miserable — are both done badly by the current market. A platform built NERIS-native in 2026, after the NFIRS retirement, has a structural advantage over incumbents retrofitting a legacy schema.

## Locked decisions

| | |
|---|---|
| **Scope** | Full suite — alerting, personnel + duty shifts, training/certs, apparatus & equipment, inventory, inspections & pre-plans, NERIS incident reporting, reporting. Delivered in dependency waves, not narrowed. |
| **EMS / ePCR** | Out. Fire-only department — no PHI, no HIPAA, no BAA, no NEMSIS. Largest scope boundary in the project; do not erode without an explicit decision. |
| **Incident reporting** | NERIS-native. NFIRS retired 2026-01-31 and is not supported. |
| **Personnel model** | All-volunteer roster with member-claimable duty shifts, LOSAP points, call/drill attendance. Not career shift scheduling. |
| **Alerting** | **App replaces radio tone-out as the path of record.** This is life-safety software. N1.9 parallel tone-out run is the compensating control for accepted SPOFs and is **not optional**. |
| **Auth** | **Sign in once and forget** — no MFA, no step-up re-authentication, no idle timeout, no session a responder can be logged out of. A login prompt on the alert path is an alerting failure, not a security control. Export and destructive admin actions are gated by Cedar role authorization **alone**; the architecture states plainly what that trade costs. |
| **Mobile** | Native iOS + Android (React Native + native notification extensions). Required, not preferred — Critical Alerts and DND override are unavailable to a PWA. |
| **Tenancy** | Single-tenant build; `{deptId}` in every partition key so a second department is additive, not a rewrite. |
| **Stack** | AWS serverless, U.S. region pinned (NERIS requirement): Cognito + Verified Permissions, Lambda, 3 DynamoDB tables, SNS FIFO (alerting) + EventBridge (LOB), Pulumi. **No MFE topology.** |
| **GitHub** | Personal `zdemanche`, not the Moonaan org. Transfer later if it makes sense. |
| **Tracker** | GitHub Issues in this repo. Not Jira. |

## Layout

One monorepo (consolidated 2026-09-23 from four `boxalarm-*` repos, now retired — history, issues, and open PRs preserved).

| Directory | Owns |
|---|---|
| [`ui/`](ui) | React Native app + React web SPA + shared `@boxalarm/*` packages. Build only. |
| [`backend/`](backend) | 10 Lambda services. Build only. |
| [`infrastructure/`](infrastructure) | All Pulumi. The only thing that touches AWS. |
| [`docs/`](docs) | PRD, architecture, backlog. |

Each code directory is its own npm project with its own lockfile; CI runs per directory from `.github/workflows/`, path-filtered.

## Process

Moonaan SDLC: PRD → `/sdlc:generate-architecture` → `/sdlc:arch-compile` → `/sdlc:generate-backlog` → `/sdlc:generate-code` per story.

Architecture went through **4 rounds of independent review** (cap extended once by explicit decision). Round 1 returned 4 CRITICAL + 23 MAJOR; all resolved or explicitly carried forward as tracked issues.

## Start here

Blocking items with external lead times — these gate everything and should be moving now:

- [#2](https://github.com/zdemanche/Boxalarm-monorepo/issues/2) CAD integration surface — *how does Chief360 get dispatch today?*
- [#3](https://github.com/zdemanche/Boxalarm-monorepo/issues/3) Regional dispatch authority approval — likely the longest pole
- [#4](https://github.com/zdemanche/Boxalarm-monorepo/issues/4) Apple Critical Alerts entitlement — can be rejected
- [#5](https://github.com/zdemanche/Boxalarm-monorepo/issues/5) Who carries the pager at 03:00
- **OQ-24** — who revokes a compromised or lost session, and how fast; with expiry gone this is the only control that ends access
- [#12](https://github.com/zdemanche/Boxalarm-monorepo/issues/12) ⚠️ Read before implementing the alert path

## Docs

- `CLAUDE.md` — session handoff: current state, how to run a story, settled decisions, alerting invariants
- `docs/prd.md` — product requirements
- `docs/architecture.md` — compiled architecture (2,410 lines)
- `docs/architecture.compiled/` — tiered artifacts for `generate-code`; hash-guarded against the source
- `docs/build-order.md` — 8 epics, 90 stories, 13 dependency waves
- `docs/dependency-graph.json` — machine-readable story graph (160 edges, acyclic)
