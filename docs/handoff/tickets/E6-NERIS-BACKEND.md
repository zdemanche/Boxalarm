# E6-NERIS-BACKEND: NERIS submission via outbox with exponential backoff, plus visible, retriable submission status

**Key:** E6-NERIS-BACKEND
**Story:** E6-S8, E6-S9 backend parents
**Directory:** `backend/`
**Issues:** #90, #91

No NERIS submission path exists: there is no `POST .../submit` route, no outbox-driven submission worker, no backoff/retry, no status or retry routes, and no `neris.submission.failed` event. Build the backend half of both stories; the matching infra (#243, #244) and UI (#168, #169) are separate later runs, so publish every route path, event name, env var, and queue name you choose in the PR body for them to consume.

## Standing notes (apply to every issue below)

- **Monorepo.** Repo root is `/Users/zacharydemanche/Projects/boxalarm`. This run touches **only `backend/`** (plus tests inside it). Sibling bundle runs own the other directories; do not edit them.
- **The issues' "Current state" sections are stale** — they were written before ~30 batch PRs merged. Verify everything against the code on `main`; reuse what exists, never duplicate it.
- **Wording constraint for the plan document.** A mechanical plan gate greps for the literal string `caller-supplied` (and `caller supplies`) and fails the plan on a match, even inside a sentence that denies it. Never use those phrases. Say "derived server-side from the verified token" / "originates from the authenticated principal" instead. This changes nothing about the design.
- **Alerting invariants** (life-safety, non-negotiable): alerting plane is SNS FIFO; routing and dedup key on `channel` (never `channelTier`); exactly-once key `{dispatchId}#{toneSequence}#{memberId}#{channel}`; alerting isolation is an **IAM boundary** — no LOB role gains any alerting-table permission, and alerting Lambdas stay out of any VPC; `{deptId}` is in every partition key.
- Auth is settled: no MFA, no step-up, no session timeout. Do not add any.
- One PR closes every issue listed below; list them as `Closes #n` in the PR body.
- Reuse the E6-S7 NERIS client, config, and token cache already on main (`backend/src/services/incident-service/neris/`) and the `@boxalarm/outbox` package (`backend/packages/outbox`). The NERIS vendor account does not exist yet (OQ-23): build and test against the client's interface with fakes; the prod host stays gated off exactly as E6-S7 left it.
- Match the existing incident-service handler, repository, and test style. Add new Lambda entries to `backend/scripts/lambda-manifest.mjs` so the infra run can wire them later; do not edit `infrastructure/`.


---

# Issues in this bundle

## #90 — E6-S8: NERIS submission with exponential backoff and outbox-pattern reliability

**Epic:** E6 — The incident report writes most of itself and clears NERIS the first time  ·  **Wave:** 9

POST /api/v1/incidents/{incidentId}/submit accepts a VALIDATED incident and submits it to NERIS via the outbox pattern: the status transition and an outbox row land in one DynamoDB transaction, a Streams-triggered worker publishes `neris.incident.submitted`, and a submission worker POSTs to NERIS with the OAuth2 client from E6-S7, exponential backoff on HTTP 429, and every attempt logged to `NERIS_SUBMISSION_ATTEMPT`. Depends on E6-S1 through E6-S7.

## Acceptance criteria

1. Given a VALIDATED incident, when POST /submit is called, then the endpoint returns 202 Accepted immediately and the submission proceeds asynchronously via the outbox.
2. Given NERIS responds with HTTP 429, when the submission worker receives it, then it retries with exponential backoff internally (not a single failing attempt), and every attempt (including the 429) is appended to `NERIS_SUBMISSION_ATTEMPT` with httpStatus, outcome, and retryCount, never overwriting a prior attempt.
3. Given the department has not yet passed the N6.2 NERIS Integration Partner compatibility check, when a submission is attempted, then it cannot target the NERIS production environment under any configuration path — only NERIS dev is reachable.
4. Given a submission ultimately succeeds, when the incident is retrieved, then its status is ACCEPTED (or SUBMITTED, per NERIS's own lifecycle) and the successful attempt is visible in its submission history.

## Depends on

- `E6-S7` — Submission requires the OAuth2 client-credentials/per-environment config foundation this story builds.
- `E6-S1` — Submission acts on a VALIDATED incident built on this story's data model.
- `E6-S2` — Submission requires a created (pre-populated) incident.
- `E6-S3` — Only a VALIDATED incident (guided completion's terminal state) may be submitted.
- `E6-S4` — The narrative is part of what gets submitted.
- `E6-S5` — Response-time/unit data is part of what gets submitted.
- `E6-S6` — Secondary-schema data is part of what gets submitted.

## Test notes

Unit + contract (mock 429 in CI, one real-429 resilience check against NERIS dev on a scheduled, not per-PR, basis to respect WAF limits) + integration (F7.6, Tier 1, per Testing §3.4). E2E: incident report pre-populate -> validate -> submit to NERIS dev -> status tracked to success (Testing §3.2 flow 8).


---
*Story `E6-S8`.*


---

## #91 — E6-S9: Visible, retriable submission status — never a silent drop

**Epic:** E6 — The incident report writes most of itself and clears NERIS the first time  ·  **Wave:** 10

GET /api/v1/incidents/{incidentId}/submission surfaces current submission status (submitted/accepted/rejected/retrying/failed) and POST .../submission/retry lets an officer or admin manually retry a failed submission. `neris.submission.failed` fires on every failure regardless of DLQ state, so a failure is always visible in the UI and on the chief dashboard, satisfying F7.7's 'never silently dropped' obligation.

## Acceptance criteria

1. Given a NERIS submission fails (rejected validation, exhausted retries, or lands in the DLQ), when `neris.submission.failed` is published, then the incident's submission status becomes visibly FAILED to any officer viewing it, with the failure reason shown, regardless of whether the message also reached the DLQ.
2. Given an incident's submission status is FAILED, when an admin calls POST /submission/retry, then a new submission attempt is enqueued and a new `NERIS_SUBMISSION_ATTEMPT` record is appended, and the status transitions out of FAILED once the retry succeeds or fails again.
3. Given the chief dashboard is viewed, when any incident has a FAILED or pending NERIS submission, then it appears in the NERIS compliance view (F8.1) rather than requiring a per-incident lookup to discover.
4. Given a submission is in any state, when its status is queried, then the response always reflects the true current source-of-truth state read directly from DynamoDB — submission status is explicitly never served from a cache.

## Depends on

- `E6-S8` — Submission status/retry surfaces the outcome of the submission this story performs.

## Test notes

Unit + integration simulating 429/5xx and asserting visible + retriable state (F7.7, Tier 1). E2E: force a 429/5xx from a mocked NERIS response, assert failure surfaces to the user and is retriable (Testing §3.2 flow 9) — this is the single most important test for the epic's 'never silently dropped' obligation.


---
*Story `E6-S9`.*


---

