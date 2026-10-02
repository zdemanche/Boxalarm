# Incident Service

## Purpose & Boundaries
NERIS Core-native incident model (F7.1), pre-population from dispatch/roster (F7.2), guided completion with NERIS enumeration validation (F7.3), narrative, response times, exposures/Secondary (F7.8), officer lock/unlock, submit/resubmit to NERIS, submission status (F7.7), search (F7.9), schema-version awareness (F7.10). Own table (Streams on, PITR, customer-managed KMS). NERIS entity sync lives in platform-service, not here. Incident id = originating `dispatchId` (deptId+dispatchNumber+epochSeconds). Holds its own NERIS OAuth2 client-credentials grant.

## Interfaces
`/api/v1/incidents`: POST `` (Cedar `CreateIncidentReport`, NERIS officer tier OFFICER/CHIEF/ADMIN, 403 before any read for MEMBER/TRAINING/APPARATUS; DRAFT only); GET `` (search); GET/PUT `/{id}`; PUT `/{id}/narrative|response-times|exposures`; POST `/{id}/submit` (202 accept-and-queue; Cedar `SubmitIncidentReport` officer tier; 409 `SUBMISSIONS_DISABLED` if `CONFIG#NERIS submissionsEnabled` off); GET `/{id}/submission`; POST `/{id}/submission/retry` (admin); POST `/{id}/lock`, `/unlock`, `/resubmit` (officer tier); GET `/dispatches` (Cedar `ListRecentDispatches`); GET `/neris-schema?version=`; health pair. Unlisted but built: NERIS `validate`, per-module PUTs, no-activity reports, submissions ledger, retention disposal.

## Data Ownership
`pk=DEPT#{deptId}#INCIDENT#{incidentId}`: `INCIDENT` (METADATA; `corePayload` opaque versioned, `nerisSchemaVersion`, status DRAFT|VALIDATED|SUBMITTED|ACCEPTED|REJECTED; lock = `lockedAt` + `lockedContentVersion` on row, NOT a status; `contentVersion`; gsi1 `DEPT#{d}`/`INCIDENT#{alarmAt}`), `INCIDENT_SECONDARY` (`SECONDARY#{secondaryType}`; Sensitive non-PHI), `INCIDENT_RESPONSE_UNIT` (`RESPONSE#{apparatusId|memberId}`), `NERIS_SUBMISSION_ATTEMPT` (`SUBMISSION#{attemptedAt}`; outcome SUCCESS|RATE_LIMITED|VALIDATION_ERROR|SERVER_ERROR; `nerisEnvironment` DEV|PROD; no TTL), `SCHEMA_VERSION` (`pk=SCHEMA_VERSION`, `sk=NERIS#{version}`; S3 pinned schema keys), outbox/dedup entities. Bucket `boxalarm-incident-assets` (SSE-KMS).

## Events Produced
`neris.incident.submitted` `{incidentId, departmentId, nerisSchemaVersion, submissionStatus}` (outbox); `neris.submission.failed` `{incidentId, httpStatus, attemptNumber, willRetry, failureReason}` (always published); `neris.incident.missing`.

## Events Consumed
`alerting.dispatch.received`, `alerting.response.confirmed`, `alerting.tone.escalated`, `alerting.mutual_aid.triggered` (via bridge; annotate incident); `neris.incident.submitted` (submission worker), `neris.submission.failed` (status service).

## Dependencies
internal: alerting-service (dispatch seed copies), platform-service (entity sync, kill switch config), notification-service. external: NERIS API (OAuth2 client-credentials in Secrets Manager per env, mandatory per-env `User-Agent`, 4 s call timeout `NERIS_CALL_TIMEOUT_MS`), github `ulfsri/neris-framework` schema refresh, S3, Valkey (schema-version cache 5 min).

## Gotchas & Constraints
- Lock before send: every content write bumps `contentVersion` and carries `attribute_not_exists(lockedAt)`; worker re-reads strongly consistent before POST/PUT and abandons if unlocked/not in flight/version moved. One report per worker invocation (90 s timeout, 540 s visibility).
- Idempotent create: record expected NERIS id BEFORE POST; adopt existing record; 409/422 with findable record = adopt.
- Payload deep-picked to NERIS sub-schema; `NEVER_SENT_KEYS` strips names, DOB, SSN, phone, email, PCR id, civilian demographics at any depth; `casualty_rescues` sends required fields + enum outcome codes; `medical_details` only for MEDICAL types and only `patient_care_evaluation|patient_status|transport_disposition`; casualty missing FF/NONFF type blocks locking `CASUALTY_INCOMPLETE`. Rank/years-of-service not sent only because NERIS 1.5.1 marks optional.
- Secondary write rule: officer tier writes any module; others only a module naming them; version-conditional (409); create-once audit row.
- Never test against NERIS prod; env-config asserts non-prod; N6.2 compat check before prod. Whole loop unverified vs live NERIS (OQ-23).
- Month bucketing uses dept time zone; nightly reconciliation; give up on missing record after 3 checks (`nerisMissingAt`); terminal failure notifies owner, locker, all officers (not digest). Retry schedules self-delete.
- Never cache submission status. No TTL on INCIDENT/SECONDARY/attempts.

## Source Sections
§1.1 122–150; §1.4 NERIS 293–313; §2 incident API 419–439; Data Model §3.2 924–1008; §3.4–3.5 1410–1443; AP 44–50 1502–1508; Testing F7 2376–2389, §3.4 2506–2515.
