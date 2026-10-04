# Incident Service

## Purpose & Boundaries
NERIS-native incident model (Core + Secondary), pre-population from dispatch/roster, guided completion with pre-submit NERIS enum validation, officer lock, NERIS submission (accept-and-queue 202), submission status, search/history. Holds its own NERIS OAuth2 client-credentials grant (Secrets Manager per env, token cached until near expiry). Own `incident` table (CMK KMS), own S3 bucket `boxalarm-incident-assets` (SSE-KMS). Submission Status Service is a handler here. NERIS entity sync is NOT here (platform-service). Fire-only: no ePCR/PHI.

## Interfaces
`/api/v1/incidents`: POST (create DRAFT only; Cedar `CreateIncidentReport`, NERIS officer tier OFFICER/CHIEF/ADMIN — MEMBER/TRAINING/APPARATUS get 403 before any read); GET (search); GET `/{incidentId}`; PUT `/{incidentId}` (guided completion); PUT `/{incidentId}/narrative`; PUT `/{incidentId}/response-times`; PUT `/{incidentId}/exposures` (Secondary); POST `/{incidentId}/submit` (202; Cedar `SubmitIncidentReport`, officer tier; needs lock; kill switch -> 409 `SUBMISSIONS_DISABLED`); GET `/{incidentId}/submission`; POST `/{incidentId}/submission/retry` (admin); POST `/{incidentId}/lock`, `/unlock`, `/resubmit` (officer tier); GET `/incidents/dispatches` (Cedar `ListRecentDispatches`, officer tier); GET `/incidents/neris-schema?version=`; health pair. Untabulated but registered: NERIS `validate`, per-module PUTs, no-activity reports, submissions ledger.

## Data Ownership
Incident table (Streams, PITR). INCIDENT `pk=DEPT#{deptId}#INCIDENT#{incidentId}` `sk=METADATA` (`incidentId` = dispatchId = deptId+dispatchNumber+epochSeconds; nerisSchemaVersion; corePayload opaque versioned doc; status DRAFT|VALIDATED|SUBMITTED|ACCEPTED|REJECTED; `lockedAt`+`lockedContentVersion`, `contentVersion`; gsi1pk `DEPT#{deptId}` gsi1sk `INCIDENT#{alarmAt}`; PII address); INCIDENT_SECONDARY `sk=SECONDARY#{secondaryType}` (payload Sensitive non-PHI; affectedMemberIds); INCIDENT_RESPONSE_UNIT `sk=RESPONSE#{apparatusId or memberId}`; NERIS_SUBMISSION_ATTEMPT `sk=SUBMISSION#{attemptedAt}` (outcome SUCCESS|RATE_LIMITED|VALIDATION_ERROR|SERVER_ERROR; nerisEnvironment DEV|PROD; append-only); SCHEMA_VERSION `pk=SCHEMA_VERSION` `sk=NERIS#{version}` (status ACTIVE|DEPRECATED, coreSchemaS3Key/secondarySchemaS3Key; Valkey `incident-service:schema-version:active` 5min). No TTL on any incident entity.

## Events Produced
`neris.incident.submitted` (`{incidentId, departmentId, nerisSchemaVersion, submissionStatus}`; outbox -> `neris-submit-queue`); `neris.submission.failed` (`{incidentId, httpStatus, attemptNumber, willRetry, failureReason}` -> `neris-status-queue`; always published); `neris.incident.missing` (notifies owner, locker, every officer).

## Events Consumed
`alerting.dispatch.received`, `alerting.tone.escalated`, `alerting.mutual_aid.triggered` (via platform bus one-way bridge, to annotate incident); `neris.incident.submitted` (worker).

## Dependencies
internal: alerting-service (dispatch copy; `sourceDispatchId` ID ref only), platform-service (entity registry, kill switch config), notification-service, reporting-service. external: NERIS API (OAuth2 CC, mandatory per-env User-Agent, 4s call timeout `NERIS_CALL_TIMEOUT_MS`), `ulfsri/neris-framework` schemas pinned in S3, Secrets Manager, S3, Step Functions/Scheduler.

## Gotchas & Constraints
- Lock is NOT a status: `lockedAt`+`lockedContentVersion`; every content write bumps `contentVersion` and carries `attribute_not_exists(lockedAt)`; unlock returns to DRAFT. Worker re-reads strongly consistent immediately before POST/PUT and abandons if unlocked/not in flight/version moved.
- Idempotent create: record expected NERIS id BEFORE POST; retry looks up and adopts an existing record; 409/422 duplicate with findable record = adopt.
- Worker: one report per invocation, 90s timeout, 540s queue visibility; retry schedules self-delete; 429 = expected, exponential backoff bounded, then DLQ; never silent drop; failures put inbox item to owner/locker/all officers immediately; alarms ClientError, NotConfigured, repeated poll failure.
- Poller keeps cursor; nightly reconciliation (`ReconciliationNewDrift` alarm); record not listed for 3 nights -> `nerisMissingAt`; resubmit adopts-then-creates keeping `previousNerisIncidentId`.
- Payload to NERIS deep-picked to schema; deny-list `NEVER_SENT_KEYS` (names, DOB, SSN, phone, email, PCR id, civilian demographics) at any depth; `casualty_rescues` sends all required fields + enum outcome codes; `medical_details` only for MEDICAL incident types and only patient_care_evaluation/patient_status/transport_disposition; casualty lacking FF/NONFF type or bad code blocks lock `CASUALTY_INCOMPLETE`. Stored corePayload keeps full entered data (Sensitive PII).
- INCIDENT_SECONDARY write rule: officer tier any module; others only a module naming them and cannot change who it names; version-conditional (409); create-once audit row old/new. Read: affected member, chief, safety officer only.
- Month bucketing uses `CONFIG#NERIS timeZone`.
- Never PROD before N6.2; dev/prod host separation; whole loop unverified against live NERIS (OQ-23); NERIS ID minted once at alert time assumed (verify).
- Schema bump = config publish, no redeploy (F7.10).

## Source Sections
Backend §1.4 NERIS (293-313); §2 incident-service (419-439); Data Model §3.2 (924-1008); §3.4-3.5 (1410-1443); access patterns 44-50 (1502-1508); Events neris (1884-1885, 1906-1907, 1919); Testing F7 (2376-2389); Cross-Cutting (2723)
