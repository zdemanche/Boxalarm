# Boxalarm

Fire department operations platform. Replacement for Chief360.
Tenant zero: **Nichols Fire Department, Trumbull CT 06615.**

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
| **Mobile** | Native iOS + Android (React Native + native notification extensions). Required, not preferred — Critical Alerts and DND override are unavailable to a PWA. |
| **Tenancy** | Single-tenant build; `{deptId}` in every partition key so a second department is additive, not a rewrite. |
| **Stack** | AWS serverless, U.S. region pinned (NERIS requirement): Cognito + Verified Permissions, Lambda, 3 DynamoDB tables, SNS FIFO (alerting) + EventBridge (LOB), Pulumi. **No MFE topology.** |
| **GitHub** | Personal `zdemanche`, not the Moonaan org. Transfer later if it makes sense. |
| **Tracker** | GitHub Issues in `boxalarm-docs`. Not Jira. |

## Repos

| Repo | Owns |
|---|---|
| [`boxalarm-ui`](https://github.com/zdemanche/boxalarm-ui) | React Native app + React web SPA + shared `@boxalarm/*` packages. Build only. |
| [`boxalarm-backend`](https://github.com/zdemanche/boxalarm-backend) | 10 Lambda services. Build only. |
| [`boxalarm-infrastructure`](https://github.com/zdemanche/boxalarm-infrastructure) | All Pulumi. The only thing that touches AWS. |
| [`boxalarm-docs`](https://github.com/zdemanche/boxalarm-docs) | This repo — PRD, architecture, backlog. |

## Process

Moonaan SDLC: PRD → `/sdlc:generate-architecture` → `/sdlc:arch-compile` → `/sdlc:generate-backlog` → `/sdlc:generate-code` per story.

Architecture went through **4 rounds of independent review** (cap extended once by explicit decision). Round 1 returned 4 CRITICAL + 23 MAJOR; all resolved or explicitly carried forward as tracked issues.

## Start here

Blocking items with external lead times — these gate everything and should be moving now:

- [#1](https://github.com/zdemanche/boxalarm-docs/issues/1) CAD integration surface — *how does Chief360 get dispatch today?*
- [#2](https://github.com/zdemanche/boxalarm-docs/issues/2) Regional dispatch authority approval — likely the longest pole
- [#3](https://github.com/zdemanche/boxalarm-docs/issues/3) Apple Critical Alerts entitlement — can be rejected
- [#4](https://github.com/zdemanche/boxalarm-docs/issues/4) Who carries the pager at 03:00
- [#11](https://github.com/zdemanche/boxalarm-docs/issues/11) ⚠️ Read before implementing the alert path

## Layout

- `docs/prd.md` — product requirements
- `docs/architecture.md` — compiled architecture (2,401 lines)
