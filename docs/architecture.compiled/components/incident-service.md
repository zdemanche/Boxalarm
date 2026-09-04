# incident-service

## Purpose & Boundaries
NERIS-native incident model, pre-population from dispatch/roster, guided completion, NERIS submission, submission status, search. Wave 2. Own dedicated DynamoDB table — a distinct operational lifecycle (compliance-submission workflow with external-API retry semantics and its own schema-versioning concern), separate from the shared platform table for that reason, not for alerting-isolation reasons.

## Interfaces
Base path `/api/v1/incidents/...`.

| Method | Path | Description | Auth |
|---|---|---|---|
| POST | `/` | Create incident, pre-populated from dispatch/roster (F7.2) | Cognito |
| GET | `/` | Search/history (F7.9) | Cognito |
| GET | `/{incidentId}` | Incident detail, NERIS Core-native model (F7.1) | Cognito |
| PUT | `/{incidentId}` | Guided completion, validated against NERIS enumerations pre-submit (F7.3) | Cognito |
| PUT | `/{incidentId}/narrative` | Narrative capture (F7.4) | Cognito |
| PUT | `/{incidentId}/response-times` | Unit assignment + response times (F7.5) | Cognito |
| PUT | `/{incidentId}/exposures` | Exposure/responder-safety capture, Secondary schema (F7.8) | Cognito |
| POST | `/{incidentId}/submit` | Submit to NERIS — accept-and-queue, 202 (F7.6) | Cognito(admin) |
| GET | `/{incidentId}/submission` | Submission status: submitted/accepted/rejected/retrying/failed (F7.7) | Cognito |
| POST | `/{incidentId}/submission/retry` | Manually retry a failed submission | Cognito(admin) |

## Data Ownership
Own DynamoDB table (`incident-service`), on-demand, PITR on, Streams on (future CQRS trigger only), customer-managed KMS key (federally-reportable records).

- **INCIDENT (NERIS Core)** — `pk=DEPT#{deptId}#INCIDENT#{incidentId}`, `sk=METADATA`. `incidentId` = same value as the originating `dispatchId` (assumption — verify against real NERIS ID-minting behavior, OQ-17). `corePayload` stored as an **opaque, versioned document** (`Map (JSON)`) rather than exploded into attributes — schema updates need no migration/redeploy. `nerisSchemaVersion` per incident. `status` DRAFT|VALIDATED|SUBMITTED|ACCEPTED|REJECTED. `sourceDispatchId` FK to alerting-service `DISPATCH_ALERT` (ID reference only). `gsi1pk/sk` = `DEPT#{deptId}` / `INCIDENT#{alarmAt}`.
- **INCIDENT_SECONDARY (F7.8 exposure/responder safety)** — `sk=SECONDARY#{secondaryType}`. **The most sensitive non-PHI data in the system** — access rule narrower than the general incident read: affected member, chief, and safety officer only.
- **INCIDENT_RESPONSE_UNIT (F7.5)** — `sk=RESPONSE#{apparatusId or memberId}`. `unitType` APPARATUS|MEMBER.
- **NERIS_SUBMISSION_ATTEMPT (F7.6/F7.7)** — `sk=SUBMISSION#{attemptedAt}`, append-only log, never overwritten. `outcome` SUCCESS|RATE_LIMITED|VALIDATION_ERROR|SERVER_ERROR. `nerisEnvironment` DEV|PROD — never PROD before the N6.2 compatibility check passes. No TTL.
- **SCHEMA_VERSION (reference data, cached in Valkey)** — `pk=SCHEMA_VERSION`, `sk=NERIS#{version}`. `status` ACTIVE|DEPRECATED. `coreSchemaS3Key`/`secondarySchemaS3Key` point to a pinned copy of the published XLSX/YAML from `github.com/ulfsri/neris-framework`, refreshed on a schedule — a schema update is a config publish, never a redeploy.

No TTL on `INCIDENT`, `INCIDENT_SECONDARY`, `NERIS_SUBMISSION_ATTEMPT` — federally reportable / compliance evidence.

## Events Produced
- `neris.incident.submitted` — outbox pattern (write + outbox row in same transaction). `{incidentId, departmentId, nerisSchemaVersion, submissionStatus}`. Consumer: NERIS Submission Worker (internal handler). Transport: `boxalarm-{env}-platform-bus`.
- `neris.submission.failed` — `{incidentId, httpStatus, attemptNumber, willRetry, failureReason}`. Consumer: Submission Status Service (internal handler) + Chief Dashboard projection. Published **always**, whether or not the message eventually lands in a DLQ — a submission is never silently dropped.
- `alerting.response.confirmed` — republished (allow-listed) outward from the alerting plane, correlated here at the incident layer via shared `dispatchId`/`incidentId`.

## Events Consumed
None named directly — the dispatch/roster pre-population (F7.2) is a read-time correlation via ID reference, not an event subscription.

## Dependencies
**Internal:** correlates with `alerting-service` via the shared `dispatchId`/`incidentId` (ID reference only — no shared table, no join; independent `GetItem`/`Query` calls). References `platform-service`-owned `MEMBER`/roster and `apparatus-service`-owned units by ID for pre-population.
**External:** **NERIS API** — OAuth2 client-credentials grant (cached until near-expiry), mandatory `User-Agent` header (missing = 403 per vendor docs), exponential backoff on 429, WAF rate limits, U.S. data residency (N6.1). Base URL/credentials/`User-Agent` per-environment config (SSM/Secrets Manager) so dev traffic can never reach NERIS production by accident (N6.4). NERIS Integration Partner account (Client ID/Secret + compatibility check, N6.2) required before any production submission — business/legal step, unresolved (OQ-23).

## Gotchas & Constraints
- **Never submit to NERIS production before the N6.2 compatibility check passes** — `nerisEnvironment` must be asserted non-production at test-suite startup for anything but the release gate; a 429 is expected/non-terminal, always still results in a published `neris.submission.failed` regardless of outcome.
- **Schema-version strategy is deliberately schemaless-at-the-attribute-level** — do not explode `corePayload`/`secondaryPayload` into individual DynamoDB attributes; a NERIS schema bump changes only the mapping/validation code and the `SCHEMA_VERSION` reference item.
- **`INCIDENT_SECONDARY` access is narrower than general incident read** — enforce affected-member/chief/safety-officer-only visibility, not the general Cognito role check used elsewhere.
- **F7.10 must be directly testable against N and N-1 schema fixtures** — CI runs the mapping-layer contract suite against both on every change; a schema bump must never force a data-model redeploy.
- **Retention is export-to-S3-Glacier via a separate scheduled job (Wave 3), never DynamoDB TTL** — this is federally reportable data.
- **No incident data migrates from Chief360** — Chief360 is not NERIS-native and NFIRS is retired; migration scope (OQ-11) covers only MEMBER/quals/certs/apparatus/possibly attendance-LOSAP.
- **Assumption to verify:** the NERIS `dispatchId`/`incidentId` is minted once at alert ingestion and reused unchanged as this service's `incidentId` — if the real CAD integration or NERIS mints the number later in the workflow, the ID-composition timing needs revisiting (OQ-17).

## Source Sections
- Backend §1.1 Bounded contexts / service table — lines 116–142
- Backend §1.4 NERIS submission detail — lines 244
- API endpoints: incident-service — lines 321–334
- Data Model §1 Summary recommendation — lines 465–477
- Data Model §3.2 incident-service table (all entities) — lines 684–766
- Data Model §3.4 Retention/TTL — lines 1164–1175
- Data Model §4 Access patterns #44–50 — lines 1227–1233
- Data Model §9 Migration strategy — lines 1280–1288
- Events §5 Producer/consumer table (neris.* events) — lines 1503–1522
- Events §6 Error handling (NERIS-specific) — lines 1524–1533
- Testing §2 F7 test matrix — lines 1967–1980
- Testing §3.4 NERIS contract testing — lines 2082–2091
- Cross-Cutting → Data Protection (encryption, INCIDENT_SECONDARY sensitivity) — lines 2296–2308
- Cross-Cutting → Security & Auth (data residency, NERIS auth) — lines 2310–2327
- Open Questions §OQ-23 NERIS Integration Partner account — line 2353
