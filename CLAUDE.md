# Boxalarm — session handoff

Fire department operations platform replacing Chief360. Tenant zero: Nichols FD, Trumbull CT.
This repo is **docs only** (`zdemanche/boxalarm-docs`) — PRD, architecture, backlog. No code ships from here.

Read `README.md` for the full locked-decision table. This file is the working handoff: state, next step, and the traps.

## Where things stand (2026-09-03)

| Artifact | State |
|---|---|
| `docs/prd.md` | v0.2 — done, pushed |
| `docs/architecture.md` | v1.0, 2,401 lines — done after **4 rounds** of independent review |
| `docs/build-order.md` + `dependency-graph.json` | 8 epics · 90 stories · 13 waves · 160 edges · acyclic |
| GitHub Issues | 109 open in `boxalarm-docs` (8 epics + 90 stories + 11 open questions); 1 bootstrap issue in each code repo |
| Code | **None written yet.** All three code repos are empty except their bootstrap issue. |

**Next step: the build-phase decision gate.** The user explicitly asked for a gate before implementation
starts. Do not launch `/sdlc:generate-code` on Wave 1 until they say go.

Wave 1 (8 stories) is mostly external-dependency and platform-foundation work — see `docs/build-order.md`.

## Blocking items with external lead times

These gate real calendar time and are not code:

- [#1](https://github.com/zdemanche/boxalarm-docs/issues/1) CAD integration surface — how does Chief360 get dispatch today?
- [#2](https://github.com/zdemanche/boxalarm-docs/issues/2) Regional dispatch authority approval — longest pole
- [#3](https://github.com/zdemanche/boxalarm-docs/issues/3) Apple Critical Alerts entitlement — can be rejected
- [#4](https://github.com/zdemanche/boxalarm-docs/issues/4) Who carries the pager at 03:00
- [#11](https://github.com/zdemanche/boxalarm-docs/issues/11) ⚠️ **Read before touching the alert path** — tracks the last unverified alerting edits

## Do not relitigate

Every one of these was argued out and settled. Re-proposing them wastes a round.

- **Full suite, not an MVP slice.** The user was offered a scoped MVP and reaffirmed "i want it all". Sequencing is by dependency wave, never by scope cut.
- **Fire-only.** No EMS/ePCR → no PHI, no HIPAA, no BAA, no NEMSIS. Largest scope boundary in the project.
- **All-volunteer personnel model** — availability, duty-shift claiming, call/drill attendance, LOSAP points. Not career shift scheduling with overtime.
- **No MFE topology.** Trimmed Moonaan profile: Cognito + Verified Permissions, Lambda, 3 DynamoDB tables, Pulumi, U.S. region pinned. One React web SPA + one React Native app. The other Moonaan skills still apply; `sdlc:mfe-architecture` does not.
- **NERIS-native.** NFIRS retired 2026-01-31 and is not supported.
- **Tracker is GitHub Issues, not Jira.** The Atlassian MCP here points at `moonaan.atlassian.net` and cannot reach anything personal. `/sdlc:generate-backlog` and `/sdlc:generate-code` target Jira's REST API, so their output has to be converted to `gh issue create` / `gh issue` calls.
- **Personal GitHub `zdemanche`**, not the Moonaan org.

## Alerting invariants — the expensive part

Four review rounds went here. A silent *SMS-never-sends* defect recurred three rounds running because
each fix landed on one link of the chain and left another inconsistent.

- Alerting plane is **SNS FIFO** — EventBridge has no FIFO and ordering is load-bearing for exactly-once. LOB plane is EventBridge.
- **Routing and dedup both key on `channel`.** `channelTier` is escalation bookkeeping ONLY — never a routing or dedup input.
- Exactly-once key is `dispatchId#memberId#channel`; one immutable receipt per channel attempt.
- Alerting isolation is an **IAM boundary**, not a naming convention.
- N1.7 is documented as NOT literally satisfied. Retained parallel tone-out paging (N1.9) is the compensating control and is therefore **not optional**.
- `{deptId}` is in every partition key so a second department is additive, not a rewrite.

## How to work here

- **Trace cross-domain seams end to end as a chain, not edit-by-edit.** Every defect in this project so far lived *between* domains, never inside one. Verifying a single edit is how the alerting bug survived three rounds.
- This is life-safety software. The app replaces radio tone-out as the path of record.
- Route codegen/architecture/review through the `sdlc:*` agents — don't hand-write it.
- Prefer Read/Grep/Glob/Edit/Write over `cat`/`sed`/`grep`; a repo hook blocks Bash reads.
