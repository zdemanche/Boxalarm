# Boxalarm — session handoff

Fire department operations platform replacing Chief360. Tenant zero: Nichols FD, Trumbull CT.
This repo is **docs only** (`zdemanche/boxalarm-docs`) — PRD, architecture, backlog. No code ships from here.

Read `README.md` for the full locked-decision table. This file is the working handoff: state, next step, and the traps.

## Where things stand (2026-09-04)

| Artifact | State |
|---|---|
| `docs/prd.md` | v0.2 + the no-MFA auth decision (F9.1, N5.2) |
| `docs/architecture.md` | v1.0, 2,410 lines — done after **4 rounds** of independent review, plus the 2026-09-04 auth amendment |
| `docs/architecture.compiled/` | Tiered artifacts for `generate-code` — spine, fact sheets, routing manifest, contracts. **Hash-guarded: any edit to `architecture.md` makes it stale — re-run `/sdlc:arch-compile` or runs fall back to the full document** |
| `docs/build-order.md` + `dependency-graph.json` | 8 epics · 90 stories · 13 waves · 160 edges · acyclic |
| GitHub Issues | 109+ open in `boxalarm-docs` (8 epics + 90 stories + open questions) |
| Code | **All three repos scaffolded and pushed.** npm workspaces + TypeScript + Vitest + ESLint/Prettier in each; `boxalarm-infrastructure` has a root `Pulumi.yaml` with dev/qa/staging/prod pinned to `us-east-1`. No features yet. |

**The build-phase gate is passed** — the user said go on 2026-09-04. Wave 1's codeable stories are
E8-S1, E8-S5, E8-S7, E8-S9, E8-S11. E1-S16 and E6-S12 are external-dependency work, not code, and
E6-S7 waits on the NERIS vendor account.

## How to actually run a story

`/sdlc:execute-backlog` is **unusable here** — it STOPs when the plan names local keys (`E1-S2`) with
no Jira keys. Run stories individually instead:

1. Export the issue to a ticket file: `gh issue view <n> --repo zdemanche/boxalarm-docs --json ...`
   → `.analysis/wave-1/tickets/<KEY>.md` (already done for the Wave 1 five).
2. `/sdlc:generate-code docs/architecture.md <KEY> --no-jira --ticket-file <path> --repo <repo path>`

**Every Wave 1 story spans 2–3 repos** and `generate-code` takes one `--repo`, so a story is 2–3 runs
and 2–3 PRs. They all branch from `origin/main`, so **merge as you go or they conflict.**

## Blocking items with external lead times

These gate real calendar time and are not code:

- [#1](https://github.com/zdemanche/boxalarm-docs/issues/1) CAD integration surface — how does Chief360 get dispatch today?
- [#2](https://github.com/zdemanche/boxalarm-docs/issues/2) Regional dispatch authority approval — longest pole
- [#3](https://github.com/zdemanche/boxalarm-docs/issues/3) Apple Critical Alerts entitlement — can be rejected
- [#4](https://github.com/zdemanche/boxalarm-docs/issues/4) Who carries the pager at 03:00
- **OQ-24** Who revokes a compromised session, and how fast — now the *only* control that ends access
- [#11](https://github.com/zdemanche/boxalarm-docs/issues/11) ⚠️ **Read before touching the alert path** — tracks the last unverified alerting edits

## Do not relitigate

Every one of these was argued out and settled. Re-proposing them wastes a round.

- **Full suite, not an MVP slice.** The user was offered a scoped MVP and reaffirmed "i want it all". Sequencing is by dependency wave, never by scope cut.
- **Fire-only.** No EMS/ePCR → no PHI, no HIPAA, no BAA, no NEMSIS. Largest scope boundary in the project.
- **All-volunteer personnel model** — availability, duty-shift claiming, call/drill attendance, LOSAP points. Not career shift scheduling with overtime.
- **No MFA, no step-up, no session timeout.** Sign in once and forget: `MfaConfiguration: OFF`, 3650-day refresh on both surfaces, silent renewal. A login prompt on the alert path is an alerting failure. Export and destructive actions are gated by Cedar role check **alone** — the architecture states plainly what that costs; do not re-add a challenge, and do not quietly upgrade the claim.
- **Pulumi for infra, AWS for hosting** — Moonaan standards, reaffirmed 2026-09-04 because this could become a Moonaan app. State backend is unset (Pulumi Cloud); `pulumi stack export|import` moves it to org S3 later.
- **No MFE topology.** Trimmed Moonaan profile: Cognito + Verified Permissions, Lambda, 3 DynamoDB tables, Pulumi, U.S. region pinned. One React web SPA + one React Native app. The other Moonaan skills still apply; `sdlc:mfe-architecture` does not.
- **NERIS-native.** NFIRS retired 2026-01-31 and is not supported.
- **Tracker is GitHub Issues, not Jira.** The Atlassian MCP here points at `moonaan.atlassian.net` and cannot reach anything personal. `/sdlc:generate-backlog` and `/sdlc:generate-code` target Jira's REST API, so use `--no-jira --ticket-file` and `gh`.
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
- **Decide, don't ask.** The user wants defaults picked and stated, not decisions handed back. Reserve questions for spend, destructive actions, or scope of a whole run.
- Prefer Read/Grep/Glob/Edit/Write over `cat`/`sed`/`grep`; a repo hook blocks Bash reads.
