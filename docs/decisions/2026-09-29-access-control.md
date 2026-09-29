# 2026-09-29: Access control and alert-path capacity (fix/access-control)

**Scope:** decisions and residual risks from the security review (`.analysis/design-review/security-data.md`) and its follow-up review (`.analysis/access-control-review.md`).

## Alerting-plane request capacity (M4, review MAJOR 3)

**Decision:**
- Every authenticated alerting-plane route (`infrastructure/components/api/http-api.ts` `ALERTING_PLANE_ROUTES`) goes through a second Lambda authorizer. That authorizer has its own reserved concurrency (20), and each of these routes has its own stage throttle bucket.
- **No route is limited below the stage default of 50 rps / burst 100.** A per-route limit caps a route as well as reserving capacity for it, so a lower limit would let a smaller flood cause 429s for every responder.
- The routes carrying call-time roster traffic (responses, roster, dispatch list/detail) get 100 / 200.
- Any throttle of the alerting authorizer alarms to the chief.

**Residual, accepted:**
- **There is no per-client (per-IP) limit in front of the HTTP API.** AWS WAF cannot be associated with an API Gateway HTTP API; it attaches to REST APIs, CloudFront, ALB and AppSync.
- CloudFront is ruled out by N6.1. Moving the alerting routes to a REST API stage behind a regional WAF web ACL would cost a fixed monthly fee for the web ACL, which conflicts with the usage-based-cost constraint.
- **So:** an attacker who aims junk bearer tokens at one alerting route above its limit (≥ 50–100 rps) can still get 429s returned to legitimate callers of *that route*. The flood also consumes the alerting authorizer's reserved concurrency, which triggers the Throttles alarm.
- **What the isolation does buy:** a flood aimed at any LOB route no longer touches alerting capacity.
- **Compensating control:** N1.9 parallel tone-out. Paging does not go through the API at all: fan-out and delivery are an internal pipeline. The residual therefore affects seeing and answering a call in the app, not being paged.

**Revisit if** a flood is ever observed, or if the department accepts the WAF cost. The change would be a REST API stage for `ALERTING_PLANE_ROUTES` with a regional WAF rate-based rule.

## Architecture updates pending `docs/architecture.md` (for the next `/sdlc:arch-compile`)

These are not yet in `docs/architecture.md`. Editing that document makes `docs/architecture.compiled/` stale, so the changes are recorded here to be folded in and recompiled together. Each item names the architecture passage it amends.

1. **§Session and re-authentication policy, "Compensating controls" (`architecture.md:2625`).** The phrase "per-device revocation from the admin console" is not deliverable today. Replace it with the behaviour below.
   - Cognito device tracking does not apply to the hosted-UI authorization-code flow that both apps use.
   - `RevokeToken` needs the refresh token itself, and nothing records which refresh token belongs to which device.
   - So **"Report device lost" signs the member out on every device.** It also removes their push registration, so the lost phone stops showing dispatches. The member's other devices need one interactive sign-in. SMS and voice paging continue meanwhile.
   - Path to true per-device revocation: record each access token's `origin_jti` against the device at push-token registration, and have the authorizer deny that `origin_jti` instead of the whole member.

2. **Same passage: the member-status revocation now disables the login.** LOA or RETIRED writes a revocation marker, calls `AdminDisableUser`, then calls `AdminUserGlobalSignOut`. A return to ACTIVE or PROBATIONARY calls `AdminEnableUser`.
   - The consumer acts on the member row's current status, re-reads it after each Cognito call and reconciles (review MAJOR 2).
   - Only failed records are retried (partial batch responses).
   - `LoginEnableFailed` alarms.

3. **§4.1 Auth, Pre Token Generation.** The trigger refuses to mint a token, on sign-in and on every refresh, for a member whose row says LOA or RETIRED.
   - This check is independent of the disable call succeeding.
   - It **fails open** when the lookup errors (single 800 ms attempt), because it sits under every responder's silent refresh.

4. **§4.1 Auth, "Centralized validation".** The authorizer no longer checks only the four JWT claims. It also refuses any access token whose `iat` is at or before the member's revocation marker (`DEPT#{deptId}#SESSION_REVOCATION#{sub}`), so **revocation takes effect within about 30 seconds** rather than the 1-hour token life.
   - Each warm instance reads the marker at most once per member per 30 s (two attempts, about 600 ms budget); if the read fails, a stale cached answer is used.
   - If there is no answer at all, **every alerting-plane route fails open** (review MAJOR 1). This covers dispatch reads, responses, roster, manual dispatch, tone ladder, mutual aid, riding board, push tokens, alerting ops and self-test. An outage of the platform table must never degrade alerting.
   - LOB routes fail closed. `RevocationCheckFailOpen` alarms.
   - **This is a new platform-table read on the authorizer path.** State it wherever the architecture says the alerting plane has no dependency on the other tables.

5. **§4.1 Auth, authorizers.** There are now two authorizer Lambdas running the same code. The alerting one serves only `ALERTING_PLANE_ROUTES`, with its own reserved concurrency and per-route throttles, and runs with `REVOCATION_CHECK_FAIL_OPEN=true`. The other serves every other route. See the capacity section above for the no-WAF residual.

6. **§2 platform-service route table.** Add these two routes:

   | Route | Cedar action | Alarm |
   |---|---|---|
   | `POST /api/v1/platform/sessions/revoke` | `RevokeSession` (CHIEF/ADMIN) | Chief notified on every use |
   | `POST /api/v1/platform/sessions/reset-credentials` | `ResetMemberCredentials` (CHIEF/ADMIN) | Chief notified on every use |

   - Reset-credentials calls `AdminResetUserPassword`, then signs out. The revocation marker is written before the reset and again after the sign-out.
   - Both routes have web controls on the member page.

7. **§2 personnel-service, `PUT /members/{memberId}/status`.** Only CHIEF or ADMIN may change a CHIEF or ADMIN member's status. Every LOA and every RETIRED change alarms the chief.

8. **§3.5 `INCIDENT_SECONDARY` writes.** The officer tier may write any module. Any other member may write only a module that names them, and may not change who it names.
   - Writes are version-conditional (409 on conflict).
   - Every write adds a create-once audit row holding the old and new values.

9. **Identity.** `allowAdminCreateUserOnly: true` (self sign-up is off).

10. **Uploads (§8 S3 conventions).**
    - An extension allowlist covers documents and photos.
    - Presigned PUTs are signed over `Content-Type`. The API returns the signed type, and the clients must send it.
    - Presigned GETs force a safe response type.
    - Size is not capped. That needs presigned POST.

## Known widening, recorded (original review MINOR 13)

Device loss writes a `personnel.member.updated` outbox row from platform-service with `source: personnel-service`, because that is the only producer the alerting-plane rule accepts. The payload carries `changedBy: {service: platform-service, reason: DEVICE_LOSS, actorId}`.

This widens the set of Lambdas that can emit an event whose `contactChannels` flow into the alerting eligibility snapshot. The fix belongs in the outbox drain: a per-producer allow-list of event types, so a row's `source` is checked against the Lambda that wrote it rather than trusted. It is not done here.

On merging `fix/page-chain`, `invalidateMemberPush` must switch to page-chain's `writePushDevices` (see commit `c6e4d66`).
