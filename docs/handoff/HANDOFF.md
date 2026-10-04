# Handoff — 2026-10-04 post-#374 sweep

Goal: finish remaining codeable open issues after PR #374 landed on main.

## Done this session

- **#374 merged** to main (`6dff1e63`) — alerting hardening, CAD ingress, NERIS loop, access control, member roles, apparatus/inventory/inspections/reporting/notification infra, web+mobile suites.
- **56 story issues closed** as already implemented (evidence comments via GitHub MCP). Prior `docs/handoff/triage/` tables are superseded.
- Residual codeable set tracked in `docs/handoff/tickets/RESIDUAL-2026-10-04.md`.
- Three parallel branches in flight:
  - `cursor/residual-ui-87f9` — #146 #148 #161 #144 #122 #131 (UI)
  - `cursor/residual-backend-87f9` — #206 #251 #232 #131 #260 (backend)
  - `cursor/residual-infra-87f9` — #257 #235 #260 #206 (infra); Valkey #238/#256 deferred unless clean

## Left open on purpose

- Life-safety human sign-off: #12, #24
- External/human: #2–#10, #13, #19, #22, #116 (Apple entitlement), #241 (safety officer Cedar role)
- Epic containers: #1, #14–#18, #20, #21
- Docs carry-forward: #11

## Traps (unchanged)

- No CloudFront — S3 presigned URLs.
- Every platform-table-mutating role needs `auditMutationDenyStatement` (#257).
- Alerting isolation is an IAM boundary.
- Exactly-once key `{dispatchId}#{toneSequence}#{memberId}#{channel}`.
- No MFA / step-up / session timeout.
