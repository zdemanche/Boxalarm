# boxalarm-infrastructure

All AWS infrastructure for **[Boxalarm](https://github.com/zdemanche/boxalarm-docs)** — a fire department operations platform. Tenant zero: Nichols Fire Department, Trumbull CT.

**This repo is the only thing that touches AWS.** [`boxalarm-ui`](https://github.com/zdemanche/boxalarm-ui) and [`boxalarm-backend`](https://github.com/zdemanche/boxalarm-backend) are build-only. Pulumi (TypeScript), deployed via GitHub OIDC → central org role.

## Hard constraints

- **U.S. region pinned.** NERIS requires servers inside U.S. geographic boundaries — a vendor obligation, not a preference. No global edge, no cross-region replication.
- **Usage-based cost only.** An unpaid volunteer municipal fire department is paying for this. Anything that idles expensively is the wrong answer; that constraint drove out OpenSearch, Kafka, and provisioned capacity.
- **No maintenance window may take alerting down.** Ever.

## What gets provisioned

| Area | Resources |
|---|---|
| Identity | Cognito user pool, Verified Permissions policy store |
| Data | 3 DynamoDB tables — `alerting`, `incident`, `platform`. On-demand, PITR on, Streams on from day one |
| Alerting transport | SNS **FIFO** topic + per-channel SQS **FIFO** queues, each with a paired DLQ |
| LOB transport | EventBridge `boxalarm-{env}-platform-bus` + rules → consumer SQS queues + DLQs |
| Scheduling | EventBridge Scheduler for one-time escalation timers |
| Compute | Lambda per service. **Alerting Lambdas are not VPC-attached** — no ENI cold start on the alert path |
| Encryption | Customer-managed KMS keys for the alerting and incident tables; AWS-managed for platform. Valkey encrypted at rest and in transit |
| Audit | CloudTrail incl. DynamoDB **data events** on the alerting table; S3 Object Lock (compliance mode) for audit entries and delivery receipts |

**Why SNS FIFO and not EventBridge for alerting:** FIFO ordering plus `MessageDeduplicationId` is load-bearing for the exactly-once delivery guarantee, and EventBridge has no FIFO mode.

## Environment separation

Per-environment NERIS base URL, OAuth credentials, and a distinct `User-Agent`. Dev traffic must never reach the NERIS production host.

## Push credentials (set out-of-band, per stack)

Push goes to APNs and FCM directly — no push vendor. `ChannelWorkers` creates four empty secrets per stack; the push worker cannot page anyone until they hold values. Full JSON shapes are in the header of `components/alerting/channel-workers.ts`.

| Secret | Value |
|---|---|
| `boxalarm-{env}-alerting-push-apns-credentials` | `{"teamId","keyId","privateKey"(.p8 PEM),"bundleId","environment"?:"production"\|"sandbox","interruptionLevel"?:"critical"\|"time-sensitive"}` |
| `boxalarm-{env}-alerting-push-apns-sandbox-credentials` | Same shape; always sent to the APNs sandbox host. Used for devices that registered `apnsEnvironment: development` (Xcode-installed builds) |
| `boxalarm-{env}-alerting-push-fcm-credentials` | Firebase service-account key JSON, as downloaded. FCM's `apns` block (for iOS devices still on a legacy FCM token) takes its interruption level from the **APNs** secret's `interruptionLevel`, the single source of truth. An optional `"apnsInterruptionLevel"` here is used only when the APNs secret cannot be read |
| `boxalarm-{env}-alerting-push-fcm-sandbox-credentials` | Service-account JSON for a service account **in the app's own Firebase project**. Do not create a separate "sandbox" project: its sends fail with `SENDER_ID_MISMATCH`. Isolation comes from `validate_only`, which validates and delivers nothing |

> **⚠ One APNs environment per stack — get this right or every iOS member loses push.**
> Each iOS device registers the APNs environment its build is signed for (`apnsEnvironment`: `development` for Xcode-installed builds, `production` for TestFlight and App Store; a device registered without one is `production`). The worker sends every push to that device on its own environment's host. The main APNs secret serves production devices, and the sandbox secret serves development devices. A token sent to the other host gets `BadDeviceToken`, the same answer as for a dead token, so one stack can now serve both kinds of build. The main secret's optional `environment: sandbox` remains only for older dev stacks whose devices registered before `apnsEnvironment` existed.
> Safety net: per department, the push worker invalidates at most 3 distinct tokens within the current and previous 5-minute windows. The 4th trips a latch, stored as items `TRIPPED` (1 hour) and `RECENT_TRIP` (24 hours) under pk `DEPT#{deptId}#PUSH_TOKEN_INVALIDATION` in the alerting table. For 24 hours after a trip no token is invalidated, even once the 1-hour latch lapses; nothing extends that period. An operator who has fixed the secret can delete both items to re-open it early. Meanwhile those pages fail loudly instead (`…-push-mass-invalidation-blocked` pages, then the push DLQ). The first 3 tokens of a burst are still invalidated. A burst of invalidations also pages (`…-push-token-invalid-rate`). Invalidated members get push back when they next open the app.
> The app does not report its APNs environment at registration. That needs a small native module to read the provisioning profile's `aps-environment`, and it is not built.

Set `interruptionLevel` to `time-sensitive` until Apple grants the Critical Alerts entitlement (#4). `critical` without that entitlement does not get critical treatment. `time-sensitive` needs the Time Sensitive Notifications capability, which is now in `ui/apps/mobile/ios/Boxalarm/Boxalarm.entitlements` and must also be enabled on the App ID in the developer portal. Neither level has been verified on a device in Sleep Focus yet. A self-test or canary push rings the member's real device. APNs goes through the device's own environment, as above, with the title prefixed `TEST — ` and `test: "true"` in the data. FCM uses the FCM sandbox secret with `validate_only`, and fails closed if that secret is unset. A test is kept apart from real paging by its one-member audience, its TEST label and the absence of escalation, not by a separate host. Sending iOS tests to the sandbox host made every TestFlight/App Store device's self-test fail with `BadDeviceToken`. A self-test refused for a configuration reason is recorded as a failed test and not retried. Examples: sender or topic mismatch, credentials refused. A real page refused the same way throws, dead-letters and pages on-call.

Before relying on push, run the device checklist in `docs/runbooks/push-device-verification.md`. It covers critical and time-sensitive delivery, foreground presentation, and cold, background and foreground tap routing on iOS and Android.

## Deploying

`lambdaCode()` (`components/shared/lambda-code.ts`) wires each Lambda to `../backend/dist/<service>/<function>/index.mjs`.
**Run `cd backend && npm run bundle` before every deploy.** On qa, staging and prod a missing bundle fails
`pulumi preview`/`pulumi up`. Only the dev stack (and unit tests) may fall back to a placeholder, with a
`lambdaCode: no bundle found for ...` warning. The placeholder answers HTTP routes with 501 and throws on every
stream, queue, schedule or async event, so those retry into their DLQs and page instead of being acknowledged.

## Getting started

Wave 1 foundations are in progress — see [PR #90](https://github.com/zdemanche/boxalarm-infrastructure/pull/90) and the open `-INFRA` issues. Stacks: `dev`, `qa`, `staging`, `prod` (`Pulumi.<env>.yaml`).
