# 2026-09-29: NERIS loop review — dispositions and open items

Context: the independent review of `feat/neris-loop` (`.analysis/neris-loop-review.md`) returned 1 critical, 9 major and 16 minor findings. This records how each was settled on the branch, the one scope decision it forced, and what is still open.

## Decision (M9): what may be sent to NERIS

Fire-only means no PHI in NERIS payloads. The rule is now enforced structurally rather than by convention:

- NERIS receives only what its schema declares. Every module is deep-picked to its NERIS sub-schema, compiled from the NERIS OpenAPI document that the daily schema refresh downloads. Content comes only from what the department entered in a NERIS section.
- `casualty_rescues` sends the fields NERIS marks required, at every level. Round 2 (coordinator's decision) adds the casualty outcome codes under `casualty`: the injured/non-fatal, fatal or uninjured status, the cause, and the coded firefighter-injury details (job classification, duty, activity, incident stage, PPE). Only enum values are sent from that sub-tree, never free text, numbers or booleans. Unit ids and reported unit names inside it are also not sent.
- A casualty entry with no FF/NONFF `type` blocks locking (`CASUALTY_INCOMPLETE`). It is never sent as `{}`. A bad outcome code blocks too. A bad value in a field that is never sent does not block.
- Optional civilian demographics (birth month/year, gender, race), rank and years of service are never sent. Neither are names, date of birth, SSN, phone, email, or the PCR id, wherever they appear.
- `medical_details` is sent only for MEDICAL incident types, and then only `patient_care_evaluation`, `patient_status` and `transport_disposition`.

To reverse this, change the payload builder (`incident-service/neris/payload.ts`). That would need an explicit fire-only exception.

## Dispositions

| Finding | Outcome |
|---|---|
| C1 incident types not NERIS | Fixed. `TypeIncidentValue` comes from the downloaded NERIS spec. The web picker offers only NERIS values. Local validation blocks anything else and suggests the NERIS types a legacy or CAD value could be. The fake NERIS server enforces enums and `additionalProperties: false`. |
| M1 submit bypassed the lock | Fixed. Submit and retry require the lock and no send in flight. Lock refuses while a send is in flight. Unlock sets the report back to DRAFT. Create accepts DRAFT only. The web shows Submit only once the report is locked. |
| M2 create not idempotent | Fixed. The expected NERIS id is recorded before the POST. A retry looks it up and adopts an existing record. A duplicate refusal is treated as an adopt. All NERIS calls time out after 6 s. |
| M3 reused retry schedules | Fixed. Each schedule has a unique name and deletes itself after it runs. A send silent for one hour is no longer counted as in flight. |
| M4 structure fires unlockable | Fixed. The API route and the web now have module editors rendered from the NERIS sub-schemas, and the checklist links straight to them. |
| M5 lock pin missed edits | Fixed. Every content write bumps `contentVersion`, and the lock pins that version. The riding consumer checks the lock. `editedSinceSubmission` compares payload hashes. |
| M6 silent send failures | Fixed. Terminal failures put an item in the inbox right away for the owner, the locker and every officer, and also go into the digest. Alarms to the chief LOB topic fire on ClientError, NotConfigured and repeated poll failure. |
| M7 poller starvation, no repair | Fixed. The poller keeps a cursor, schedules each record by age, backs off on failure and ages records out. Reconciliation applies status drift and re-queues missing records. |
| M8 config failure blocked lock | Fixed. It now produces a warning (NERIS_UNREACHABLE). |
| M9 PHI / pass-through | Fixed per the decision above. |
| Minor 1 401 kept cached token | Fixed. The cached token is dropped and the call retried once. |
| Minor 2 stale poller writes | Fixed. Status writes are conditional on the NERIS id and the previous status. |
| Minor 3 editedSinceSubmission false positives | Fixed by M5's hash comparison. |
| Minor 4 re-lock hid the ledger | Fixed. The ledger shows whenever the report was ever sent. Submit refuses a report that has a NERIS id (resubmit instead). An auto-submit lock of such a report emits `resubmitted`. |
| Minor 5 second-granularity pin | Fixed by M5's `contentVersion`. |
| Minor 6 UTC months | Fixed. Months use the department time zone (NERIS config `timeZone`, default America/New_York). |
| Minor 7 duplicate no-activity filing | Fixed. The report NERIS already has on file is adopted. |
| Minor 8 entity sync | Fixed. Sync is async (202, then a worker). Station and unit ids are reused only under the same entity. Units left out of a request keep their ids. |
| Minor 9 compliance tile | Fixed. The tile shows owner names, and the rejection rate counts send-time 422s. |
| Minor 10 reconciliation hid duplicates | Fixed. |
| Minor 11 history key collisions | Fixed. |
| Minor 12 members spending NERIS calls | Fixed. Members get local checks only. |
| Minor 13 unfiltered keys | Fixed by M9's deep-pick. |
| Minor 14 dept id is Pulumi config | Open (below). |
| Minor 15 test fidelity | Mostly fixed. The fake server is strict, and there are tests for lock/submit/retry/riding enforcement and for schedule-name uniqueness. There are no axe unit checks, because only `@axe-core/playwright` is installed (open, below). |
| Minor 16 digest-only rejections | Fixed by M6's immediate inbox item. |

## Round 2 dispositions

The round-2 review (`.analysis/neris-loop-review-round2.md`) approved with minors. Fixed on the branch:

| Finding | Outcome |
|---|---|
| N1 failure after success | A create refused with any 422 while the NERIS id can be predicted is looked up first and adopted. A failure write is conditional on the report not being ACCEPTED. A miss is treated as superseded, and no retry is scheduled. |
| N2 send after unlock/edit | The worker re-reads the report (strongly consistent) right before the POST/PUT. It abandons without sending if the report is unlocked, no longer in flight, or its `contentVersion` moved. The lock pins `lockedContentVersion`, and the lock's context reads are consistent. |
| N3 staffing missed the pin | The riding consumer bumps `contentVersion` in the same transaction as the staffing write, conditioned on not locked. |
| N4 untyped casualty | Blocks lock (`CASUALTY_INCOMPLETE`). It is never sent as `{}`. |
| N5 casualty decision | Outcome codes are sent (decision above). |
| N6 missing-record loop | Given up on after 3 nightly checks: `nerisMissingAt` is set and `neris.incident.missing` goes to the owner, the locker and the officers. There are alarms on NerisStatusPollExpired, ReconciliationDriftDetected and NerisRecordMissing. |
| N7 kill switch | Submit and retry answer 409 `SUBMISSIONS_DISABLED` or `NOT_CONFIGURED`. A retry already scheduled is recorded without a notice or an alarm. |
| N8 schema version skew | `GET /incidents/neris-schema?version=` serves the report's pin. The web asks for it. |
| N9 entity sync | The row gets a FAILED state with its reason. The worker has no async retry and an on-failure SQS destination with an alarm. A failed invoke resets the row. Before a create, the existing station or unit is looked up by station id or CAD designation. |
| N10 timeout budget | 4 s per call. One report per invocation, a 90 s worker timeout and a 540 s queue visibility timeout. |
| N11 consistent lock reads | Folded into N2. |
| UNDETERMINED mixed | Blocks lock (`UNDETERMINED_WITH_TYPES`). |
| Fake server fidelity | PUT bodies are validated. A duplicate create is refused. The entity GET is served. |
| Axe | Playwright axe covers the fire-protection step with a filled module. |

Deliberately not done (reviewer: skip):

- **N12 remainder:** string patterns and formats are not compiled into the schema.
- **N14:** `editedSinceSubmission` still has edge-case false positives, and the poll cost is unchanged.
- **S2:** free-text fields inside modules.
- **S3:** empty `additional_attributes`.
- **Minor 14:** below.

## Still open

- **Unverified against a live NERIS account.** No authenticated call has been made:
  - 201/422 bodies;
  - the duplicate-create response. The code now adopts on any 409 or 422 once the record can be found by id;
  - approval-status behaviour;
  - the entity/station/unit responses.

  Paths, auth and payload shapes are checked against both live OpenAPI documents only.
- **Minor 14.** The scheduled NERIS jobs sweep `NERIS_SCANNER_DEPT_ID` (a comma list, from Pulumi `deptId`). This matches the other scanners. A second department means a config change, not a code change.
- **Push/email for NERIS failures** still arrive through the daily digest; only the inbox item is immediate.
- **Axe unit checks** for the new panels need a unit-level axe package, which the web app does not have. The Playwright axe e2e now covers the module editor with a module filled in.
- **The web module editor** does not refresh an open draft when the same module changes elsewhere.
