# Platform Service

## Purpose & Boundaries
Cognito triggers (incl. Pre Token Generation), department configuration (F9.3: STATIONS, RANKS, LOSAP_POINT_RULES, ALERT_RULES, CHECKLIST_DEFAULTS, `retention`, CAD_INGRESS, NERIS), Verified Permissions policy admin, cross-service audit-log sink (F9.4), data export (F9.5), session revoke/credential reset, CAD source management, NERIS entity registry + async entity sync worker. Owns the `platform` DynamoDB table which the eight LOB services share. Out of scope: alert delivery.

## Interfaces
GET/PUT `/api/v1/platform/config` (admin; PUT ALERT_RULES must reject `requiredQuals` naming a qual code no currently-eligible member holds — validator NOT yet built; amendment obligation); GET `/audit`; POST `/export`, GET `/export/{jobId}` (accept-and-queue; Cedar CHIEF/ADMIN only, alarmed on every invocation); POST `/sessions/revoke` (Cedar `RevokeSession`; body `{memberId, deviceId?}`; signs out on every device via marker+global sign-out, removes push from deviceId or all; chief notified; protected-target gated); GET `/sessions/{memberId}/devices` (Cedar `ViewMemberDevices`; installation id, platform, last registration — never the token); POST `/sessions/reset-credentials` (Cedar `ResetMemberCredentials`; `AdminResetUserPassword` then sign-out; marker written before reset and again after sign-out); GET/PUT `/platform/neris/entity` (PUT -> 202 + worker); GET/PUT `/platform/cad-sources` (Cedar `ManageCadIngress`); POST `/cad-sources/test-parse`; POST `/cad-sources/{sourceId}/email-address` (old address stops within a minute); POST `/cad-sources/{sourceId}/webhook-key` (rotate HMAC + API Gateway key; previous lives 24h); POST `/cad-sources/{sourceId}/webhook-key/revoke-previous`; health pair. Table is non-exhaustive; registrations in `infrastructure/components/api/http-api.ts` authoritative.

## Data Ownership
Platform table (AWS-managed key, Streams, PITR). Generic GSIs: GSI1 `gsi1pk=MEMBER#{memberId}`/`gsi1sk={entityType}#{sortValue}`; GSI2 `gsi2pk=DEPT#{deptId}#DUE#{entityType}#{YYYY-MM}`/`gsi2sk={dueDate}#{entityId}`; GSI3 `gsi3pk=DEPT#{deptId}#{entityType}[#GEO#{geohash5}|#ADDR#{normalizedAddress}]`/`gsi3sk={sortValue}#{entityId}`. DEPARTMENT_CONFIG `pk=DEPT#{deptId}` `sk=CONFIG#{configType}`, `value`, `version`. NERIS entity row `sk=NERIS#ENTITY` on same bare partition; `CONFIG#NERIS` holds `submissionsEnabled` kill switch and `timeZone` (default America/New_York). AUDIT_LOG_ENTRY `pk=DEPT#{deptId}#AUDIT#{YYYY-MM-DD}` `sk={ts}#{entityType}#{entityId}#{actorId}`, gsi3 `DEPT#{deptId}#AUDIT#ENTITY#{mutatedEntityType}#{mutatedEntityId}`/`{ts}`; no TTL, archive to S3 after 2 years. Session revocation marker `DEPT#{deptId}#SESSION_REVOCATION#{sub}` (platform table). OUTBOX_ENTRY `pk=OUTBOX#{aggregateId}` `sk=EVT#{eventId}` TTL 7d after sentAt; EVENT_DEDUP `pk=DEDUP#{consumerName}` `sk=EVT#{eventId}` TTL 48h. S3 buckets `nichols-boxalarm-platform-assets` and `boxalarm-exports-staging` (7-day expiry). Valkey keys: `platform-service:dept-config:{deptId}#{configType}` TTL 5min; `platform-service:dashboard:{deptId}` 5-15min.

## Events Produced
`platform.config.alert_rules.updated` (outbox, on PUT config with configType=ALERT_RULES; payload deptId, toneLadder{tone2AtSeconds,tone3AtSeconds,mutualAidAfterTone}, retoneRespondingMembers, voiceEscalatesPerTone, defaultRule, callTypeOverrides; transport platform bus -> `alert-rules-copy-queue`+DLQ maxReceive 5). `personnel.member.updated` emitted from device-loss handler with `source: personnel-service` (known widening; `changedBy` names actor; per-producer allow-list at drain pending). Audit events (outbox AuditEvent stream). CAD config propagates to `CAD_INGRESS_COPY`. NERIS entity sync events.

## Events Consumed
AuditEvent stream from all services (sink); member status changes (LOA/RETIRED) -> revocation + login-disable consumer.

## Dependencies
internal: personnel-service (`writePushDevices` imported across boundary), alerting-service, incident-service, infrastructure. external: Cognito (AdminDisableUser/AdminEnableUser/AdminUserGlobalSignOut/AdminResetUserPassword), Verified Permissions, NERIS API (entity sync, holds client credentials), Secrets Manager, SSM, S3, Valkey.

## Gotchas & Constraints
- LOA/RETIRED consumer: write revocation marker, `AdminDisableUser`, then `AdminUserGlobalSignOut`; ACTIVE/PROBATIONARY -> `AdminEnableUser`; acts on current member status, re-reads after each Cognito call; only failed records retried; `LoginEnableFailed` alarms.
- Pre Token Generation refuses tokens for LOA/RETIRED on sign-in and every refresh; FAILS OPEN on lookup error (single 800ms attempt).
- Self sign-up off (`allowAdminCreateUserOnly: true`). Cognito: `MfaConfiguration: OFF`, refresh 3650d, rotation with grace window.
- Export uses a dedicated read-only role with read to all three tables — only sanctioned cross-table IAM principal; Cedar CHIEF/ADMIN, no step-up.
- NERIS entity sync worker holds NERIS client secret; LeadingKeys grant matches partition key only, so it can still write `CONFIG#*` rows including kill switch and `DEPT#*#OUTBOX` — accepted known gap; fix = move row to `DEPT#{deptId}#NERIS_ENTITY` (migration, follow-on).
- Malformed outbox row dropped (`MalformedOutboxRow` alarm); queue policies key on rule ARN not bus ARN.
- Reporting Projections DynamoDB rollup counters live on this table (not CQRS).
- Disposal: verified hard delete for LOB; crypto-shredding for archived incident/receipt classes.
- Member-email change is guarded in personnel-service but writes marker `LOGIN_EMAIL_CHANGE`.

## Source Sections
Backend §1.1 (122-150); §1.4 outbox amendment (285-291); §2 platform-service endpoints (354-373); §4.1-4.2 (544-560); Data Model DEPARTMENT_CONFIG/AUDIT/retention (1379-1422); Events reconciliations 6 (1633-1639); Events ALERT_RULES event (1858-1877); Cross-Cutting Data Protection/Session policy (2721-2734); Security (2736-2754)
