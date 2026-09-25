# incident-service

## Purpose & Boundaries

NERIS-native incident model, pre-population from alert/roster, guided completion, NERIS submission, submission status tracking, incident search. Service 5 of 10, Wave 2. **Own dedicated physical DynamoDB table** (distinct lifecycle from platform-service: compliance-submission workflow with external-API retry semantics and its own schema-versioning concern).

## Interfaces

Base path `/api/v1/incidents/...`.

| Method | Path | Description | Auth |
|---|---|---|---|
| POST | `/` | Create incident, pre-populated from dispatch/roster (F7.2) | Cognito |
| GET | `/` | Search/history (F7.9) | Cognito |
| GET | `/{incidentId}` | Incident detail, NERIS Core-native (F7.1) | Cognito |
| PUT | `/{incidentId}` | Guided completion, validated against NERIS enums pre-submit (F7.3) | Cognito |
| PUT | `/{incidentId}/narrative` | Narrative capture (F7.4) | Cognito |
| PUT | `/{incidentId}/response-times` | Unit assignment + response times (F7.5) | Cognito |
| PUT | `/{incidentId}/exposures` | Exposure/responder-safety, Secondary schema (F7.8) | Cognito |
| POST | `/{incidentId}/submit` | Submit to NERIS — accept-and-queue, 202 (F7.6) | Cognito(admin) |
| GET | `/{incidentId}/submission` | Submission status: submitted/accepted/rejected/retrying/failed (F7.7) | Cognito |
| POST | `/{incidentId}/submission/retry` | Manually retry failed submission | Cognito(admin) |
| GET | `/health/liveness` \| `/health/readiness` | Health | none |

## Data Ownership

Own physical table (Streams on, PITR on, customer-managed KMS key — federally-reportable records).

- **INCIDENT** (NERIS Core) — `pk=DEPT#{deptId}#INCIDENT#{incidentId}`, `sk=METADATA`. `incidentId` = **same value as the originating `dispatchId`** (assumed minted once at alert ingestion — see Open Questions). `corePayload` stored as opaque versioned document, not exploded attributes — a schema bump needs no migration/redeploy. `address` **PII**. `status`: `DRAFT`|`VALIDATED`|`SUBMITTED`|`ACCEPTED`|`REJECTED`. `sourceDispatchId` FK (ID reference only, no join) to alerting-service's `DISPATCH_ALERT`.
- **INCIDENT_SECONDARY** — `sk=SECONDARY#{secondaryType}`. `payload` **Sensitive, non-PHI** — the most sensitive non-PHI data in the system; access narrower than the general incident read (affected member, chief, safety officer only).
- **INCIDENT_RESPONSE_UNIT** — `sk=RESPONSE#{apparatusId or memberId}`. Response-time capture.
- **NERIS_SUBMISSION_ATTEMPT** — `sk=SUBMISSION#{attemptedAt}`. Append-only, never overwritten. `nerisEnvironment`: `DEV`|`PROD`, never PROD before N6.2 compatibility check passes. No TTL (compliance evidence).
- **SCHEMA_VERSION** — `pk=SCHEMA_VERSION`, `sk=NERIS#{version}`. Reference data, Valkey-cached. `coreSchemaS3Key`/`secondarySchemaS3Key` pin published XLSX/YAML from `ulfsri/neris-framework`.

No TTL on `INCIDENT`/`INCIDENT_SECONDARY` — federally reportable records, retention via export job per N6.3.

## Events Produced

- `neris.incident.submitted` — outbox, on submission. Consumer: NERIS Submission Worker.
- `neris.submission.failed` — from the Submission Worker. Consumers: Submission Status Service (handler within this service), Chief Dashboard projection.

## Events Consumed

None named directly — pre-population reads `alerting-service`'s dispatch record and roster via ID reference, not an event subscription.

## Dependencies

**Internal:** `alerting-service` — ID-reference-only correlation via shared `dispatchId`/`incidentId` (assumed minted once at alert ingestion — **verify against actual NERIS behavior before incident stories are built**, per Risks §17). `reporting-service` reads this table's GSI1 for compliance views.

**External:** **NERIS API** (Verified tier — public docs read directly: OAuth 2.0, Swagger at `api.neris.fsri.org/v1/docs`, schemas at `github.com/ulfsri/neris-framework`, WAF rate limits, mandatory `User-Agent`, U.S. residency, mandatory separate dev environment). NERIS Integration Partner account provisioning is unresolved (OQ-23, blocking any production submission).

## Gotchas & Constraints

- **`nerisSchemaVersion` per-incident, opaque payload storage** — a NERIS schema bump changes only validation/mapping code and the `SCHEMA_VERSION` reference item; the table itself needs no migration. Existing incidents keep validating against the version they were written under.
- **Never PROD before N6.2 Integration Partner compatibility check passes** — base URL, credentials, `User-Agent` are all per-environment config (SSM/Secrets Manager) so dev traffic can never reach NERIS production by accident.
- **A 429 from NERIS is expected, not terminal** — exponential backoff internally before `maxReceiveCount` exhausts to DLQ; `neris.submission.failed` is always published regardless, so a submission is never silently dropped (F7.7).
- **No incident data migrates from Chief360** — Chief360 is not NERIS-native and NFIRS is retired; migration scope is limited to `MEMBER`/`MEMBER_QUALIFICATION`/`CERTIFICATION`/`APPARATUS`/possibly historical `ATTENDANCE_RECORD`/`LOSAP_POINT_ENTRY` (personnel-service's domain, not this service's).
- **Assumed:** a single NERIS `dispatchId`/`incidentId` is minted once at alert ingestion and reused unchanged as this table's key. If NERIS or the eventual CAD integration mints the number later in the workflow, this ID-composition timing needs revisiting.

## Source Sections

- Backend §1.1 Service inventory (`:120-146`)
- Backend §1.4 NERIS submission pattern (`:267`)
- Backend §2 incident-service API endpoints (`:354-369`)
- Data Model §1, §3.2 INCIDENT through SCHEMA_VERSION (`:538-546`, `:841-924`)
- Data Model §3.4 Retention, §3.5 PII classification (`:1321-1354`)
- Data Model §4 Access patterns 44-51 (`:1412-1420`)
- Events §Other domains, `neris.incident.submitted`/`neris.submission.failed` (`:1787-1817`)
- Testing §2 F7 test matrix (`:2284-2297`)
- Risks and limitations item 17 (`:2719`)
