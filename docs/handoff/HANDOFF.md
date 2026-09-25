# Handoff — 2026-09-25 issue sweep

Goal: finish every codeable open issue, one PR per bundle of related issues. Read the root `CLAUDE.md` first (alerting invariants, settled decisions).

## Done this session

- **#353 merged** — `docs/architecture.md` on main had been clobbered by #269 into a 16-line stub. Restored (sha256 `bf82b563…`) and `docs/architecture.compiled/` recompiled.
- **#354 merged** — Pages base path is now derived from the repo name (repo renamed to `zdemanche/Boxalarm`). Live at https://zdemanche.github.io/Boxalarm/.
- **59 issues closed** as already implemented, each with an evidence comment. Triage tables: `docs/handoff/triage/` (verdict + file evidence + concrete gap per issue). Issue bodies' "Current state" sections are stale — trust the triage tables and the code.

## In-flight bundles (one ticket each in `docs/handoff/tickets/`)

Each ticket is the full spec: scope, standing notes, decisions, and the issue bodies. Implement against the ticket, run the directory's tests/lint, open one PR that `Closes` the listed issues.

| Bundle | Dir | Issues | State |
|---|---|---|---|
| ELIG-INFRA (**life-safety**) | infrastructure | #114 #204 #221 #207 #208 #213 | Draft **#355** — first generation commit; finish, test, review |
| E6-NERIS-BACKEND | backend | #90 #91 | Draft **#356** — submit/worker/repository/outbox drain written; status + retry routes (E6-S9) likely missing |
| WEB-UI | ui/apps/web | #159 #160 #153 #124 #152 #137 #122 | Draft **#357** — diagnostics page started; rest not started |
| E5-INFRA | infrastructure | #195–#202 | Not started. Ticket carries a decision: add thin `handler` re-export entry files in `backend/` where `lambda-code.ts`'s `index.handler` has nothing to bind to |
| E4-INFRA | infrastructure | #181–#194 | Not started. Likely hits the same missing-`handler`-export problem — apply the E5 decision |
| PLATFORM-INFRA | infrastructure | #216 #232 #233 #257 #260 #237 #211 | Not started. Notification-service has no infra at all; #233 is life-safety (status change doesn't revoke push tokens) |
| E6-UI | ui/apps/web | #163–#167 #170 | Not started — incidents UI (routes are placeholders today) |
| MOBILE-UI | ui/apps/mobile | #143 #144 #122 #153 #160 | Not started. Ticket carries the #160 decision (self route exists; recent-dispatch picker deferred) |
| E7-BACKEND | backend | #248 #94 #99 #97 #100 #40 | Not started — reporting service is mostly unbuilt |

Several infra bundles all append to `infrastructure/index.ts` — merge them one at a time.

## Queued after those

- **Infra for new backends:** NERIS submission (#243, #244) after #356; reporting (#247, #248, #250, #253, #267) after E7-BACKEND.
- **UI for new backends:** NERIS submit + status (#168, #169); reporting UI (#117); cutover decision UI (#161).
- **Follow-up to file:** member-readable "recent dispatches" alerting route (backend + infra) so mobile diagnostics can offer a picker (#160).
- **Remaining partials** (see triage tables): #214 cert attachments need S3 presigned (no CloudFront — residency test), #238 Valkey deferred, #241 "safety officer" Cedar role undecided, #206 LOSAP accrual is inline not queued, #146/#148 no member-facing shift positions read endpoint, #131 no restock endpoint, #116/#115 native iOS/Android notification extensions, #232 staleness check measures write age not propagation lag (backend fix), #235 riding-board deviations.
- **Site-wide UI polish pass** after E6-UI and WEB-UI land: every screen to `docs/design.md` ("Command console") + `docs/a11y-spec.md`, screenshot-verified. The bar is best-in-class vs Chief360.

## Left open on purpose

#12 and #24 (life-safety architecture verification — triage says done in code, needs a human sign-off). #237 is fixed by PLATFORM-INFRA. External/human items: #2–#8, #10, #13, #19, #22.

## Traps

- No CloudFront anywhere — `infrastructure/test/residency-encryption.test.ts` fails global-edge resources. Use S3 presigned URLs.
- Every platform-table-mutating role needs `auditMutationDenyStatement` (#257).
- Alerting isolation is an IAM boundary: no LOB role gets alerting-table access; alerting Lambdas never in a VPC.
- Exactly-once key `{dispatchId}#{toneSequence}#{memberId}#{channel}`; route and dedup on `channel`, never `channelTier`.
- No MFA / step-up / session timeout — settled.
