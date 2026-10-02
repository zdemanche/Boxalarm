# Infrastructure

## Purpose & Boundaries
Pulumi (TypeScript) is the single owner of every AWS resource for every environment (dev/qa/staging/prod); `boxalarm-backend` and `boxalarm-ui` carry no IaC. Deploys via GitHub OIDC -> central org role. Owns: API Gateway HTTP API + two authorizer Lambdas, CAD webhook REST API (usage-plan keys), SNS FIFO topic/SQS FIFO queues/DLQs (`messaging-alerting.ts`), EventBridge bus + rules (`messaging.ts`), EventBridge Scheduler, the 3 DynamoDB tables (+ CMKs for alerting/incident), S3 buckets, SES inbound, Cognito pool/app clients, Verified Permissions store, IAM boundaries, alarms, CodeDeploy, VPC for Valkey only. All pinned to a U.S. region (`us-east-1`).

## Interfaces
Route registrations in `infrastructure/components/api/http-api.ts` and each service's route components are the authoritative endpoint registry. `requireAll` seal covers ONLY the 17 alerting-plane routes (renamed/unregistered alerting route fails deploy; renamed LOB route does not). Tests: `infrastructure/test/api/ui-route-contract.test.ts` (client<->route drift), `infrastructure/test/api/fail-open-contract.test.ts` (backend `FAIL_OPEN_ROUTE_KEYS` == `ALERTING_PLANE_ROUTES` exactly, never contain an officer read). Authorizers: two Lambdas, same code; alerting authorizer serves only `ALERTING_PLANE_ROUTES`, reserved concurrency 20, `REVOCATION_CHECK_FAIL_OPEN=true`, per-route throttle buckets never below stage default 50 rps / burst 100 (call-time roster routes: responses, roster, dispatch list/detail 100/200); other serves all other routes fail-closed. Throttle of alerting authorizer alarms to chief. Residual: no per-client rate limit (WAF cannot attach to HTTP API; CloudFront ruled out by N6.1).

## Data Ownership
Three tables: alerting (CMK, Streams, PITR, on-demand), incident (CMK), platform (AWS-managed key). TTL attribute `ttl`. Buckets: `nichols-boxalarm-platform-assets`, `boxalarm-incident-assets` (SSE-KMS), `boxalarm-exports-staging` (7d expiry); Block Public Access, SSE-S3, versioning off, AbortIncompleteMultipartUpload 7d, Intelligent-Tiering, IA at 60d; archive to S3 with Object Lock compliance mode for audit entries/receipts.

## Events Produced
absent — the source document does not address this.

## Events Consumed
absent — the source document does not address this.

## Dependencies
internal: every backend service, ui apps (hosting). external: AWS (Lambda, API Gateway, DynamoDB, SNS, SQS, EventBridge, Scheduler, Step Functions, Cognito, Verified Permissions, S3, SES, KMS, CloudTrail, CloudWatch, X-Ray, CodeDeploy, ElastiCache Serverless Valkey, Secrets Manager, SSM); Pulumi Cloud state (unset backend per source repo notes absent here).

## Gotchas & Constraints
- Alerting isolation is an IAM boundary: alerting execution roles hold no permission on platform/incident tables; only the F9.5 export role (read-only, all three tables) is a cross-table principal; identity-path reads (authorizer revocation marker, Pre Token Generation) are bounded fail-open exceptions. LOB push worker reads the 3 APNs/FCM secrets read-only.
- Queue policies allow SendMessage with `aws:SourceArn` = delivering RULE arn, never bus arn.
- Every queue paired DLQ (`RedrivePolicy`); alerting maxReceive 3, others 5; alarm `ApproximateNumberOfMessagesVisible > 0`; alerting DLQ alarms page immediately. 11 SQS queues each with own DLQ (alerting 4, training, apparatus, inventory, NERIS 2, scheduling, personnel 2, alert-rules-copy 1).
- Alerting Lambdas deploy only via versioned alias + CodeDeploy linear/canary (e.g. 10% every 2 min); canary gate; CloudWatch alarms (fan-out p99, delivery-failure rate, canary failure) double as rollback triggers; new required GSI backfill completes before code hits 100%.
- Alerting reserved concurrency; no alerting Lambda in a VPC; Valkey-using services attach to VPC with Gateway endpoints for DynamoDB/S3.
- Lambda arm64; readiness via scheduled synthetic invocation.
- Cost: ElastiCache floor $40-50/mo flagged; total est. $120-175/mo.
- DR: PITR on all; RPO <=5 min; RTO <=4h LOB, alerting target <=1h (optimistic; restore drill is a release gate). CloudTrail incl. DynamoDB data events on alerting table.
- WAF paid options unapproved; CAD API keys are capacity partitions not credentials.
- Dispatches table retention export-to-Glacier job assigned to Wave 3 (until built storage grows unbounded).
- Secrets: NERIS creds per env; distinct User-Agent per env; env config via Secrets Manager/SSM injected at deploy.

## Source Sections
Backend §0 (110-116); Tech stack (522-538); §4 (544-584); Messaging transport (269-284); Events §1, §5-6 (1651-1657, 1891-1926); Cross-Cutting repo topology (2672-2685); SPOF (2704-2719); Data Protection (2721-2734); Cost (1544-1567); S3 (1569-1580)
