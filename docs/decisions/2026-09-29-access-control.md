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
