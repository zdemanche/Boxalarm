# E7-BACKEND: Reporting service: rollup projections, chief dashboard, response-time analytics, ISO report, CSV/PDF export, cutover decision

**Key:** E7-BACKEND
**Story:** E7-S1/S2/S4/S6/S9 backend + E1-S15 decision route
**Directory:** `backend/`
**Issues:** #248, #94, #99, #97, #100, #40

Only LOSAP year-end, grants, and membership trends exist in reporting-service. Build: the E7-S2 rollup projection consumer (#248 describes its events and the rollup items — build the backend consumer; the queue/rule wiring is a later infra run, so treat #248 as `Refs`), the chief operational dashboard read endpoint over those rollups (#94), turnout/travel/total response-time analytics with percentiles (#99), the cross-domain ISO report (#97), CSV/PDF export for all reports (#100), and for #40 the missing E1-S15 cutover-gate pieces: the decision-write (accept/defer) persistence route and the retained-paging notice data (AC3/AC4); the delivery-baseline metrics already exist in alerting-service — read them, don't duplicate.

## Standing notes (apply to every issue below)

- **Monorepo.** Repo root is `/Users/zacharydemanche/Projects/boxalarm`. This run touches **only `backend/`** (plus tests inside it). Sibling bundle runs own the other directories and run concurrently; do not edit them.
- **The issues' "Current state" sections are stale** — written before ~30 batch PRs merged. Verify everything against `main`; reuse what exists, never duplicate it.
- **Wording constraint for the plan document.** A mechanical plan gate greps for the literal string `caller-supplied` (and `caller supplies`) and fails the plan on a match, even inside a sentence that denies it. Never use those phrases. Say "derived server-side from the verified token" / "originates from the authenticated principal" instead.
- **Alerting invariants** (life-safety): alerting plane is SNS FIFO; routing and dedup key on `channel` (never `channelTier`); exactly-once key `{dispatchId}#{toneSequence}#{memberId}#{channel}`; alerting isolation is an IAM boundary; `{deptId}` is in every partition key.
- Auth is settled: no MFA, no step-up, no session timeout.
- One PR closes the issues listed below as `Closes #n`, except where a note says an issue is only partly delivered — use `Refs #n` for those.
- Match the existing reporting-service style (`backend/src/services/reporting-service/{losap,grants,membershipTrends}` — handler + repository + tests, `lib/`, `dynamoClient.ts`). Reuse the existing CSV/PDF generation the training transcript uses (`backend/src/services/training-service/transcript/get.ts`) rather than adding a new PDF library, if it fits.
- Add new Lambda entries to `backend/scripts/lambda-manifest.mjs` so a later infra run can wire them; publish every route, event name, env var and queue name in the PR body. Do not edit `infrastructure/`. A concurrent backend run (E6-NERIS-BACKEND) also appends to the manifest — keep your edit to appended lines only.
- Response times come from incident-service's per-unit response records (`backend/src/services/incident-service/responseUnitRepository.ts`); read their shape, do not change it.


---

# Issues in this bundle

## #248 — E7-S2-INFRA: Reporting rollup projections from domain events

**Parent:** https://github.com/zdemanche/Boxalarm-monorepo/issues/95 · **Wave:** 11

The Reporting Projections consumer's queue, rules and isolation.

## Scope
- `boxalarm-{env}-platform-bus` rules → `reporting-projection-queue` + DLQ (`maxReceiveCount` 3–5). Events: `personnel.attendance.recorded`, `neris.incident.submitted`, `neris.submission.failed`, and the certification, apparatus out-of-service and shift-coverage events named in the parent, per the Eventing §4 catalog.
- Reporting Projections Lambda (VPC-less), SQS event source with partial batch failure reporting.
- IAM: `UpdateItem`/`PutItem` on platform-service table rollup items and `EVENT_DEDUP` items (`DEDUP#{consumerName}`, 48h TTL). No other table.
- CloudWatch alarm on DLQ depth → standard on-call topic, never the alerting-plane page-immediately path.

## Acceptance criteria
1. Given each listed event type is put on the bus, when rules evaluate, then it is delivered to `reporting-projection-queue` (AC1, AC2).
2. Given the Lambda role, when simulated, then a conditional `PutItem` on `EVENT_DEDUP` and an upsert `UpdateItem` on a non-existent rollup item are both allowed (AC3, AC5).
3. Given a poison message, when retries exhaust, then it sits in this DLQ, the standard on-call alarm fires, and no alerting-plane queue, concurrency or alarm is touched (AC4, N1.5).

## Depends on
- E8-S8-INFRA (platform bus), E8-S5-INFRA (platform table), E6-S8-INFRA, E6-S9-INFRA, E8-S11-INFRA.



---

## #94 — E7-S1: Chief operational dashboard

**Epic:** E7 — Compliance and grant reports come out of the system instead of into a spreadsheet  ·  **Wave:** 12

Give the chief a single dashboard screen showing current staffing, response performance, out-of-service apparatus, expiring certifications, and NERIS submission compliance (F8.1), served from pre-aggregated DynamoDB rollup items rather than ad-hoc queries at read time.

## Acceptance criteria

1. Given a chief with the admin/chief role, when they open the dashboard, then they see current active-member count, count of members marked off/unavailable, and staffing-vs-shift-coverage summary sourced from personnel-service data
2. Given at least one apparatus is currently out of service, when the dashboard loads, then that apparatus and its OOS reason/duration appear in the OOS panel, sourced from apparatus-service data
3. Given certifications expiring within the department-configured lead time, when the dashboard loads, then the count and list of affected members/certs appear, sourced from the GSI2 due-date index
4. Given incidents pending or rejected NERIS submission, when the dashboard loads, then the NERIS compliance panel shows the count and links to each failed/pending submission (F7.7/F8.1)
5. Given the underlying rollup item is up to 15 minutes stale, when the dashboard renders, then a 'last updated' timestamp is shown so the chief knows the data's freshness
6. Given a non-admin/non-chief member requests the dashboard endpoint, when the request is made, then it is rejected with 403

## Depends on

- `E8-S1` — Every endpoint in the reporting domain requires a valid Cognito-issued JWT validated by the shared Lambda authorizer before any business logic runs.
- `E8-S3` — Admin/officer-gated writes in the reporting domain are enforced by Verified Permissions Cedar policy, which must exist before those endpoints can be correctly authorized.
- `E7-S2` — The dashboard is served from the pre-aggregated rollup items this story maintains.
- `E4-S5` — The OOS-apparatus panel is sourced from out-of-service tracking data.
- `E3-S2` — The expiring-certifications panel is sourced from the cert-expiry due-date index.
- `E6-S9` — The NERIS-compliance panel is sourced from submission status/failure data.
- `E2-S1` — Active-member/staffing counts are sourced from the roster.
- `E2-S9` — Staffing-vs-shift-coverage summary is sourced from coverage visibility.

## Test notes

Unit tests on rollup-read logic and the dashboard endpoint's role check (Cognito(admin) per architecture §2). Playwright E2E covering dashboard load with seeded OOS/expiring-cert/NERIS-failure fixtures. Axe accessibility pass on the dashboard screen (data tables, status badges must not rely on color alone). Definition of done: GET /api/v1/reporting/dashboard implemented against DynamoDB rollup items (Data Model Events §5 'Reporting Projections'), no live cross-service calls at read time.

**Components:** reporting-service, boxalarm-ui

---
*Story `E7-S1`.*


---

## #99 — E7-S6: Response-time analytics (turnout, travel, total)

**Epic:** E7 — Compliance and grant reports come out of the system instead of into a spreadsheet  ·  **Wave:** 9

Compute and surface turnout, travel, and total response-time analytics per incident and aggregated over a period, from unit response-time data already captured on incidents (incident-service INCIDENT_RESPONSE_UNIT, F7.5) — feeds both the chief dashboard and ISO reporting (F8.5).

## Acceptance criteria

1. Given an incident with recorded dispatchedAt/enRouteAt/arrivedAt timestamps per unit, when response-time analytics are computed, then turnout time (dispatchedAt to enRouteAt), travel time (enRouteAt to arrivedAt), and total time (dispatchedAt to arrivedAt) are calculated correctly per unit
2. Given a period-level analytics request, when computed, then median and 90th-percentile turnout/travel/total times are shown across all incidents with complete timestamp data in the period
3. Given an incident's unit is missing one or more timestamps, when the aggregate is computed, then that unit's incomplete record is excluded from the specific metric it cannot support, and the report indicates how many records were excluded
4. Given the requested period, when queried, then incident-service's GSI1 date-range query (architecture access pattern zdemanche/Boxalarm-monorepo#56) is used rather than a full table scan

## Depends on

- `E6-S5` — Turnout/travel/total analytics compute directly from the per-unit response-time timestamps this story captures.

## Test notes

Unit tests for turnout/travel/total math including missing-timestamp exclusion. Performance check that the GSI1 date-range query pattern is used, not a Scan, per architecture §4 access pattern 48. Definition of done: GET /api/v1/reporting/response-times implemented; percentile computation documented (app-side, given the small per-department incident volume noted in architecture §7).

**Components:** reporting-service

---
*Story `E7-S6`.*


---

## #97 — E7-S4: ISO reporting support

**Epic:** E7 — Compliance and grant reports come out of the system instead of into a spreadsheet  ·  **Wave:** 12

Produce the ISO-support report drawing together training hours (training-service), apparatus testing records (apparatus-service), hydrant flow-test data (inspections-service), and response performance (incident-service/alerting-service), the specific combination ISO grading requires, without the department re-keying it by hand (F8.3).

## Acceptance criteria

1. Given a date range, when an admin requests the ISO report, then it includes total training hours by category (from training-service's ISO-aligned rollup, F3.5), apparatus test pass/fail history by test type (from APPARATUS_TEST_RECORD), hydrant flow-test currency (from HYDRANT records via GSI2), and response-time summary for the same range
2. Given one of the four source domains has no data in the requested range, when the report is generated, then that section renders empty/zero rather than causing the whole report to fail
3. Given the report spans a period crossing multiple GSI2 month-bucket partitions, when the report aggregates due-date data, then results are correct across the partition boundary
4. Given a non-admin member requests this report, when the request is made, then it is rejected with 403

## Depends on

- `E3-S6` — The ISO report includes training hours from this story's ISO-aligned rollup.
- `E4-S8` — The ISO report includes apparatus test pass/fail history from this story.
- `E5-S3` — The ISO report includes hydrant flow-test currency from this story's records.
- `E6-S5` — The ISO report includes response-time summary data from this story.
- `E7-S2` — ISO reporting reads rollups where they exist per this story's projection consumer.

## Test notes

Unit tests for cross-domain aggregation with each source domain independently empty/populated. Integration test against seeded fixtures spanning a month boundary to verify the two-partition GSI2 query pattern (architecture §7). Definition of done: GET /api/v1/reporting/iso implemented; depends on E7-S2 rollups where used, and reads training-service/apparatus-service/inspections-service data directly where no rollup exists yet.

**Components:** reporting-service

---
*Story `E7-S4`.*


---

## #100 — E7-S9: CSV/PDF export for all reports

**Epic:** E7 — Compliance and grant reports come out of the system instead of into a spreadsheet  ·  **Wave:** 13

Add accept-and-queue CSV/PDF export to every report in this epic (dashboard, LOSAP, ISO, grants, response-time, membership trends), writing generated files to the short-lived boxalarm-exports-staging S3 bucket and returning a download link, per F8.7.

## Acceptance criteria

1. Given an admin requests CSV export of any report in this epic, when the export job completes, then a CSV file matching the on-screen report's data is available via a signed download link
2. Given an admin requests PDF export of any report in this epic, when the export job completes, then a PDF matching the on-screen report's data and layout is available via a signed download link
3. Given an export covers a large date range, when requested, then the endpoint returns 202 accept-and-queue immediately rather than blocking the request (per architecture's accept-and-queue pattern for F8.7/F9.5)
4. Given an export job fails, when the admin checks its status, then the failure is visible rather than the job silently disappearing
5. Given an exported file has been available for 7 days, when the exports-staging bucket lifecycle rule runs, then the file is expired per the bucket's documented 7-day lifecycle policy

## Depends on

- `E7-S1` — CSV/PDF export of this report depends on its underlying data/endpoint from E7-S1; explicitly named as a dependency in E7-S9.
- `E7-S3` — CSV/PDF export of this report depends on its underlying data/endpoint from E7-S3; explicitly named as a dependency in E7-S9.
- `E7-S4` — CSV/PDF export of this report depends on its underlying data/endpoint from E7-S4; explicitly named as a dependency in E7-S9.
- `E7-S5` — CSV/PDF export of this report depends on its underlying data/endpoint from E7-S5; explicitly named as a dependency in E7-S9.
- `E7-S6` — CSV/PDF export of this report depends on its underlying data/endpoint from E7-S6; explicitly named as a dependency in E7-S9.
- `E7-S7` — CSV/PDF export of this report depends on its underlying data/endpoint from E7-S7; explicitly named as a dependency in E7-S9.

## Test notes

Unit tests for CSV/PDF generation per report type. Integration test for the accept-and-queue job status flow (GET /api/v1/reporting/export). Verify Pulumi config for boxalarm-exports-staging's 7-day lifecycle rule matches architecture §8. Definition of done: export endpoint implemented for all six report types from E7-S1/S3-S7; depends on those stories for source data.

**Components:** reporting-service, boxalarm-infrastructure

---
*Story `E7-S9`.*


---

## #40 — E1-S15: Parallel tone-out run, delivery baseline, and cutover decision gate (N1.9)

**Epic:** E1 — A volunteer never misses the call for duty  ·  **Wave:** 8

As a chief, I decide whether to retire radio tone-out based on measured delivery data rather than on a vendor's assurance. Until that gate is passed, tone-out paging is retained as the compensating control for the accepted single points of failure named in the architecture's SPOF table.

## Acceptance criteria

1. Given the platform is live, when a dispatch occurs, then tone-out paging continues to run in parallel and the platform's own delivery outcome is recorded independently of it.
2. Given a reporting period, when the cutover report is generated, then it states per-member and department-wide delivery rate, missed-page count, and time-to-first-ack against the tone-out baseline.
3. Given the department is considering cutover, when the chief opens the decision gate, then the report shows whether the measured delivery rate meets the agreed threshold and the gate records an explicit accept/defer decision with a date and a named decider.
4. Given cutover has not been accepted, when anyone attempts to disable tone-out, then the system does not present that as a completed step and the retained-paging requirement is visible in the admin surface.

## Depends on

- `E1-S9` — The cutover decision reads the delivery audit log this story produces.

## Test notes

This is a business/operational gate story like E6-S12, not a pure engineering story. The report computation is testable; the decision is human. Non-CI obligation per architecture N1.8/N1.9.

**Components:** reporting-service, boxalarm-ui

---
*Story `E1-S15`.*


---

