# Platform Service

## Purpose & Boundaries
Cognito triggers (Pre Token Generation), department config (F9.3), Verified Permissions policy admin, cross-service audit sink (F9.4), data export (F9.5), session revocation/device loss/credential reset, CAD source config, NERIS entity registry sync worker, `ALERT_RULES` propagation. Owns the `platform-service` table that 8 services share. Config changes at runtime without deploy (not env vars).

## Interfaces
`/api/v1/platform`: GET/PUT `/config` (admin; PUT with `configType=ALERT_RULES` MUST reject `requiredQuals` naming a qual no eligible member holds — validator NOT designed, owed); GET `/audit`; POST `/export` (accept-and-queue) + GET `/export/{jobId}`; POST `/sessions/revoke` (Cedar `RevokeSession` CHIEF/ADMIN; `{memberId, deviceId?}`); GET `/sessions/{memberId}/devices` (`ViewMemberDevices`; never returns token); POST `/sessions/reset-credentials` (`ResetMemberCredentials`); GET/PUT `/neris/entity` (PUT -> 202 + async worker); GET/PUT `/cad-sources` (`ManageCadIngress`); POST `/cad-sources/test-parse`, `/{sourceId}/email-address`, `/{sourceId}/webhook-key`, `/{sourceId}/webhook-key/revoke-previous`; health pair.

## Data Ownership
Platform table (see personnel/apparatus/etc. for entities). Own: `DEPARTMENT_CONFIG` (`pk=DEPT#{deptId}`, `sk=CONFIG#{configType}`; types STATIONS|RANKS|LOSAP_POINT_RULES|ALERT_RULES|CHECKLIST_DEFAULTS, plus `retention`, `CAD_INGRESS`, `NERIS` incl. `submissionsEnabled`, `timeZone` default America/New_York; `version` counter); NERIS entity row `sk=NERIS#ENTITY` on bare dept partition (known gap: worker IAM LeadingKeys matches pk only, can write CONFIG#* incl. kill switch; fix = move to `DEPT#{deptId}#NERIS_ENTITY`, follow-on); `AUDIT_LOG_ENTRY` (`pk=DEPT#{d}#AUDIT#{YYYY-MM-DD}`, `sk={ts}#{entityType}#{entityId}#{actorId}`, gsi3 `DEPT#{d}#AUDIT#ENTITY#{type}#{id}`/`{ts}`; no TTL; archive to S3 after 2y); `DEPT#{deptId}#SESSION_REVOCATION#{sub}` marker; `OUTBOX_ENTRY` (`OUTBOX#{aggregateId}`/`EVT#{eventId}`, ttl 7d after sentAt). GSIs: GSI1 my-records, GSI2 due-window month-bucketed, GSI3 lists/geo/audit.

## Events Produced
`platform.config.alert_rules.updated` (outbox on ALERT_RULES write); audit events (`AuditEvent` stream); device-loss emits `personnel.member.updated` with `source: personnel-service` via imported `writePushDevices` (recorded widening; per-producer allow-list pending).

## Events Consumed
`personnel.member.updated` (LOA/RETIRED -> revocation marker, `AdminDisableUser`, `AdminUserGlobalSignOut`; ACTIVE/PROBATIONARY -> `AdminEnableUser`; reconcile, re-read after each call, retry failed records only, `LoginEnableFailed` alarm); audit-bearing mutations from all services.

## Dependencies
internal: personnel-service. external: Cognito (`allowAdminCreateUserOnly: true`), Verified Permissions, Secrets Manager/SSM, NERIS API (sync worker holds client credentials), S3 (`boxalarm-exports-staging`).

## Gotchas & Constraints
- Export runs under dedicated READ-ONLY role over all three tables (only non-alerting principal with alerting-table access); Cedar CHIEF/ADMIN only; alarm on EVERY invocation; no re-auth challenge.
- reset-credentials and device-loss protected-target gated: acting on CHIEF/ADMIN needs ADMIN actor; revocation marker written before reset and again after sign-out; chief notified every use. Per-device revocation is NOT deliverable (sign-out is per-member everywhere).
- Member email change: CHIEF/ADMIN only; CHIEF/ADMIN target only by ADMIN; writes marker `LOGIN_EMAIL_CHANGE`, signs out, notifies previous address, alarms `MemberEmailChanged`.
- Pre Token Generation: refuses LOA/RETIRED on sign-in and refresh; single 800 ms attempt; fails OPEN on error.
- Platform table is read by authorizer (marker) — bounded isolation exception.
- Retention: `retention` configType for N6.3; disposal = verified hard delete (LOB) / crypto-shredding (incident, receipts).
- Valkey caches config 5 min (`platform-service:dept-config:{deptId}#{configType}`) and dashboard.

## Source Sections
§1.1 122–150; §2 platform API 354–373; §4.1 544–554; §4.2 556–560; Data Model §3.3 DEPARTMENT_CONFIG/AUDIT 1379–1408; §3.4 1410–1422; Events §6 1633–1639; Data Protection 2721–2735; Security 2736–2754.
