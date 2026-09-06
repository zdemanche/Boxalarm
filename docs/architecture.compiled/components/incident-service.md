# incident-service

## Purpose & Boundaries
NERIS-native incident model, pre-population from dispatch/roster, guided completion, NERIS submission, submission status tracking, and incident search. Owns its own dedicated DynamoDB table (distinct operational lifecycle: external-API compliance submission with its own retry/backoff and schema-version concern). No NFIRS legacy model — NFIRS retired 2026-01-31, out of scope.

## Interfaces
Base path `/api/v1/incidents/...`.

| Method | Path | Auth |
|---|---|---|
| POST | `/` (pre-populated from dispatch/roster) | Cognito |
| GET | `/` (search/history) | Cognito |
| GET | `/{incidentId}` | Cognito |
| PUT | `/{incidentId}` (guided completion, NERIS enum validation pre-submit) | Cognito |
| PUT | `/{incidentId}/narrative` | Cognito |
| PUT | `/{incidentId}/response-times` | Cognito |
| PUT | `/{incidentId}/exposures` (Secondary schema) | Cognito |
| POST | `/{incidentId}/submit` (accept-and-queue, 202) | Cognito(admin) |
| GET | `/{incidentId}/submission` | Cognito |
| POST | `/{incidentId}/submission/retry` | Cognito(admin) |

## Data Ownership
Own dedicated DynamoDB table (Streams on, PITR on, customer-managed KMS key — federally-reportable records).
- `INCIDENT` — `pk=DEPT#{deptId}#INCIDENT#{incidentId}`, `sk=METADATA`. `incidentId` = NERIS-format ID (deptId+dispatchNumber+epochSeconds), **same value as the originating `dispatchId`** — the linkage that correlates the two services without a shared table. `corePayload`: opaque versioned document (`nerisSchemaVersion`), not exploded into attributes — a schema bump needs no migration/redeploy. `status: DRAFT|VALIDATED|SUBMITTED|ACCEPTED|REJECTED`.
- `INCIDENT_SECONDARY` — `sk=SECONDARY#{secondaryType}` (F7.8 exposure/responder-safety). **Most sensitive non-PHI data in the system** — visible to the affected member, the chief, and the safety officer only, narrower than the general incident read.
- `INCIDENT_RESPONSE_UNIT` — `sk=RESPONSE#{apparatusId or memberId}`, response-time capture.
- `NERIS_SUBMISSION_ATTEMPT` — append-only log, `sk=SUBMISSION#{attemptedAt}`, `outcome: SUCCESS|RATE_LIMITED|VALIDATION_ERROR|SERVER_ERROR`, `nerisEnvironment: DEV|PROD` — never PROD before N6.2 compatibility check passes. No TTL.
- `SCHEMA_VERSION` — reference data, Valkey-cached, `pk=SCHEMA_VERSION`, `sk=NERIS#{version}`, pinned S3 keys for Core/Secondary schema documents pulled from `github.com/ulfsri/neris-framework`.

## Events Produced
- `neris.incident.submitted` (outbox) → NERIS Submission Worker.
- `neris.submission.failed` → Submission Status Service, Chief Dashboard projection. Always published on failure regardless of DLQ landing — F7.7 "never silently dropped."

## Events Consumed
None on the write path (self-contained submission worker); `alerting.tone.escalated`/`alerting.mutual_aid.triggered` may annotate the incident record via the one-way bridge (LOB-plane consumer role, read-only annotation).

## Dependencies
- **Internal**: `alerting-service` (ID-reference only — shared `dispatchId`/`incidentId`, resolved via independent `GetItem`/`Query`, never a join), `reporting-service` (F8.1 NERIS compliance view reads this table's GSI1).
- **External**: NERIS API (OAuth2 client-credentials, mandatory `User-Agent`, exponential backoff on 429, U.S. residency, WAF rate limits) — Integration Partner account provisioning unresolved (OQ-23).

## Gotchas & Constraints
- `nerisSchemaVersion` per incident: schema evolution is a config publish (new S3-pinned schema + validation/mapping code change), never a redeploy or table migration.
- Base URL, credentials, `User-Agent` are per-environment config (SSM/Secrets Manager) so dev traffic can never reach NERIS production by accident (N6.4).
- A 429 from NERIS is expected, not terminal — bounded in-process exponential backoff before `maxReceiveCount` exhausts to DLQ; `neris.submission.failed` publishes either way.
- Assumed: a single NERIS `dispatchId`/`incidentId` is minted once at alert ingestion and reused unchanged as this service's key — if NERIS or the eventual CAD integration mints the dispatch number later in the workflow, this ID-composition timing needs revisiting (OQ-17).
- No cross-tenant/cross-department incident search designed — out of scope pending OQ-14 (mutual aid).

## Source Sections
- Backend §1.1 Bounded contexts (service #5), lines 118-142
- Backend §1.4 NERIS submission detail, lines 263-264
- API endpoints, incident-service, lines 344-357
- Data Model §1 table rationale, §3.2 full entity set, lines 490-498, 788-871
- Data Model §4 Access patterns 44-50, lines 1338-1345
- Eventing §3, 4.2, 5 (NERIS flow), lines 1520-1544, 1664-1698
- Testing §2 F7 matrix, §3.4 NERIS contract testing, lines 2161-2175, 2279-2288
