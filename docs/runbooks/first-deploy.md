# First deploy of a stack (dev first), from an empty AWS account

Written from the post-merge deploy-readiness review (`.analysis/post-merge/deploy-readiness.md`) and updated for the fixes on `fix/post-merge-infra`. Every command block runs from the monorepo root and leaves the shell there: directory changes happen inside `( … )` subshells, and Pulumi commands take `-C infrastructure`. Nothing here is optional on the alert path: a step skipped silently is a page that silently does not happen.

## Account strategy

- **One AWS account per stack. Prod in its own account, always.** Stacks in one account share its Lambda concurrency pool, its 1,000-role IAM quota (each stack creates ~208 roles) and its 5-per-region CloudTrail trail limit (each stack creates 2 trails). Four stacks in one account run out of trails on the third deploy, and a dev load test can starve prod's paging Lambdas.
- Every stack is pinned to `us-east-1` (NERIS requires U.S.-only hosting).
- `scripts/preflight.mjs` enforces the parts of this it can see: it fails prod in an account that already holds another Boxalarm stack, and warns for non-prod neighbours.

## 0. Account prerequisites (before anything else)

1. **Request a Lambda concurrent-executions quota of at least 1,000** in `us-east-1`: Service Quotas → AWS Lambda → *Concurrent executions* (quota code `L-B99A9384`). A new account starts at 10. Each stack reserves 216 across 52 functions, and AWS keeps 100 unreserved, so at 10 the first reserved function fails `pulumi up`. Approval can take a day or more; wait for it.
2. Log in to Pulumi Cloud and get credentials for the stack's account (default AWS credential chain).
3. Run the preflight. It only reads the account:

   ```
   (cd infrastructure && npm ci && node scripts/preflight.mjs dev --first-deploy)
   ```

   It exits 1 and explains when the concurrency quota is under 1,000, when the stack's reservations would leave under 100 unreserved, when the stack's 2 trails would exceed 5 in the region, or when prod would share an account with another stack. Fix what it says and re-run until it passes.

## 1. Build the Lambda bundles

```
(cd backend && npm ci && npm run bundle)
ls -d backend/dist/*/*/ | wc -l     # expect 188 function directories (dist/<service>/<function>/)
```

Only dev (and unit tests) fall back to placeholder code when a bundle is missing, with a `lambdaCode: no bundle found for ...` warning. The placeholder answers HTTP with 501 and throws on every queue, stream and schedule, so do not skip this step on dev either.

## 2. Set the stack config

```
pulumi -C infrastructure stack select dev    # or: pulumi -C infrastructure stack init dev
pulumi -C infrastructure preview            # first run: lists EVERY missing key at once, with its set command
```

`components/shared/stack-config.ts` validates the whole config before anything is built and reports every missing or invalid key in one error. Each `Pulumi.<stack>.yaml` also lists, in its header comments, the keys it does not set. For dev:

```
pulumi -C infrastructure config set notificationSesFromAddress notifications@<ses-verified-domain>
pulumi -C infrastructure config set --secret smsWebhookSecret "$(openssl rand -hex 32)"
pulumi -C infrastructure config set --secret voiceWebhookSecret "$(openssl rand -hex 32)"
pulumi -C infrastructure config set --secret pushWebhookSecret "$(openssl rand -hex 32)"
pulumi -C infrastructure config set alertingPageEmail oncall@<domain>
pulumi -C infrastructure config set chiefNotificationEmail <ops or chief address>
```

- `Pulumi.dev.yaml` already carries the two safe non-secret values: `nerisSchemaSourceUrl` (an `.invalid` placeholder until the NERIS schema pipeline exists; while it is a placeholder the daily refresh schedule is created DISABLED, so nothing fails or emails daily. Other stacks refuse a placeholder) and `alertingMinEligibleMembers: "1"` (a dev department has one or two test members).
- Secrets are only ever set with `--secret`; none is committed.
- `canaryMemberId` is not needed while `canaryEnabled` is unset (false). Keep the canary off for a first deploy.
- `alertingPageEmail` and `chiefNotificationEmail` are required on prod and warned about elsewhere. Set them on dev too: without them every alarm notifies nobody.
- **qa, staging and prod:** `webOrigin` in their yaml is a `*.boxalarm.example` placeholder, and preview refuses a placeholder host (`.example`, `.invalid`, `.test`, localhost) outside dev. Set the real origin: `pulumi -C infrastructure config set webOrigin https://<real web host> --stack <stack>`. They also need `nerisSchemaSourceUrl`.
- **SMS / voice vendor (OQ-3, open):** `smsProviderEndpointUrl` / `voiceProviderEndpointUrl` are **required on prod** (prod may not ship push-only) and optional elsewhere. Until they are set on a non-prod stack, see step 3.

## 3. Deploy

```
pulumi -C infrastructure preview
pulumi -C infrastructure up
```

Expect these warnings, and no others:

- `ChannelWorkers: no provider endpoint for sms and voice ...` The SMS and voice workers are deployed against an `.invalid` placeholder, so every SMS or voice page dead-letters and fires `boxalarm-dev-alerting-sms-dlq-not-empty` (and `-voice-`) on every real dispatch. Push is the only paging channel, and radio tone-out (N1.9) stays the page of record. The stack output `ALERTING_VENDOR_ENDPOINTS_CONFIGURED` shows `{sms: false, voice: false}` until a vendor is configured. The architecture's two-vendor rule is not met until then: push (APNs/FCM direct) and SMS (third-party vendor) must be independent failure domains firing in parallel at T+0.
- No `lambdaCode: no bundle found` warnings. If you see one, go back to step 1.

## 4. Confirm the alarm subscriptions

Both notification topics use email subscriptions, and an email subscription notifies nobody until its confirmation link is clicked.

1. Click the confirmation email for `boxalarm-dev-alerting-page` (every alert-path alarm) and for `boxalarm-dev-chief-notifications` (the ops alarm topic: LOB consumer DLQs, scanners, NERIS, HTTP API, export and disposal notices).
2. Check it. The check must exit 0:

   ```
   node infrastructure/scripts/check-alarm-subscriptions.mjs dev
   ```

   It fails, naming each topic, when a topic has no subscription or any subscription is still `PendingConfirmation`. Re-run it after every change to the on-call addresses.

## 5. SES

Verify the sender identity in `notificationSesFromAddress`. In dev's SES sandbox, also verify each recipient.

## 6. Put the secret values

Infra creates the secrets empty; the values go in out-of-band:

```
aws secretsmanager put-secret-value --secret-id <name> --secret-string file://<json file>
```

| Secret | JSON shape | Needed for |
|---|---|---|
| `boxalarm-dev-alerting-push-apns-credentials` | `{"teamId","keyId","privateKey":"-----BEGIN PRIVATE KEY-----\n…","bundleId","environment"?:"production","interruptionLevel":"time-sensitive"}` | Every iOS page (TestFlight and App Store builds) |
| `boxalarm-dev-alerting-push-apns-sandbox-credentials` | Same shape; must not declare `"production"` | Xcode-installed (development) builds. Effectively required on dev |
| `boxalarm-dev-alerting-push-fcm-credentials` | Firebase service-account key JSON as downloaded, optional `"apnsInterruptionLevel"` | Every Android page |
| `boxalarm-dev-alerting-push-fcm-sandbox-credentials` | A service account in the **same** Firebase project (validate_only) | Self-test and canary validate-only sends |
| `boxalarm-dev-alerting-{sms,voice}-provider[-sandbox]-credentials` | Raw API key string (sent as Bearer) | Only once a vendor is chosen and its endpoint set (OQ-3) |
| `boxalarm-dev-neris-client-credentials` | `{"clientId","clientSecret"}` | The NERIS incident loop only |

Use `interruptionLevel: time-sensitive` until Apple grants the Critical Alerts entitlement (#4). The README's *Push credentials* section has the full rules.

## 7. Bootstrap the first admin

```
infrastructure/scripts/bootstrap-first-admin.sh dev --dept-id nichols-fd --email … \
  --first-name … --last-name … --phone +1… --rank Chief --agency-id … --role CHIEF
```

`--dept-id` must be the stack's `deptId` (`nichols-fd`). The script reads the deployed stack's department and refuses a mismatch before touching Cognito.

Then check that `DEPT#nichols-fd#ELIGIBILITY` / `MEMBER#<id>` exists in `boxalarm-dev-alerting-table`, with PUSH entries once the device registers and SMS/VOICE entries from the phone. Create the other members in the web app; each must install the app, sign in and register push.

## 8. Re-emit and backfill (all safe no-ops on an empty department)

- **Alert rules**, after saving the department's ALERT_RULES:

  ```
  (cd backend && npm run reemit-alert-rules -- --table boxalarm-dev-platform-service --dept nichols-fd)
  ```

- **Pre-plan and hydrant copies**, once inspections data exists: invoke `boxalarm-dev-inspections-alert-context-replay` with `{"deptId":"nichols-fd","dryRun":true}`, then without `dryRun` (`docs/runbooks/alert-context-replay.md`).
- **Eligibility snapshot repair**, only if `…-alerting-member-updated-dlq-not-empty` fires: re-emit the member's state (`docs/runbooks/eligibility-snapshot-repair.md`). Do not redrive that DLQ.

## 9. Verify

- `GET /api/v1/{service}/health/readiness` for all 10 services.
- A self-test from the app.
- One manual dispatch. Watch alerting-page: expect the SMS DLQ alarm while no SMS vendor is configured (step 3); the fan-out empty-roster and small-roster alarms must stay OK.
- A `…-failed-invocations` or `…-dlq-send-failed` alarm means EventBridge could not deliver an event to a consumer and did **not** dead-letter it: the event is most likely lost, so there is nothing to redrive. Fix the target's policy, then have the producer re-emit the event (member state: `docs/runbooks/eligibility-snapshot-repair.md`). An event that *was* dead-lettered shows up only through that consumer's DLQ depth alarm; redrive those.
- Run `docs/runbooks/push-device-verification.md` on iOS (Sleep Focus, time-sensitive) and Android.
- Only after all of that, consider `canaryEnabled: true` with a dedicated device (then `canaryMemberId` becomes required).

## Known gaps a first deploy does not close

- **SMS / voice** cannot page until the OQ-3 vendor is chosen and its endpoint set (step 3).
- **Runtime escalation schedules.** alerting-service creates the tone-2/3 and voice-escalation one-time schedules (`escalation/toneLadder.ts`, `escalation/scheduleEscalation.ts`) without `ActionAfterCompletion: DELETE`, so they accumulate, and without a `DeadLetterConfig`, so a scheduler-side invoke failure is not captured (Lambda's async on-failure queue still covers handler errors). A backend fix.
- **Availability events.** The personnel availability handlers write `personnel.availability.changed` outbox rows without `source`, `eventTime` or `schemaVersion`, which the outbox publisher's parser requires, so mark-offs never reach the bus or the alerting snapshot. A backend fix; until then a mark-off does not stop that member being paged.
- **Globally unique names** (S3 buckets, the Cognito domain prefix `boxalarm-<env>`) can collide with another AWS account's; `pulumi up` then fails on that resource.
- **Dev teardown.** The audit archive is COMPLIANCE-mode Object Lock for 365 days even on dev, so it cannot be deleted for a year after a `destroy`.
