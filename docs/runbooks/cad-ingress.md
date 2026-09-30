# CAD ingress: operations, alarms and the test-message procedure

CAD dispatches reach Boxalarm two ways, both decided in `docs/decisions/2026-09-29-roadmap-defaults.md` (row 3) and `docs/decisions/2026-09-29-cad-ingress-auth.md`:

- **Signed webhook** — `POST <CAD_WEBHOOK_URL>` (stack output), on its own API with its own throttle (10 rps, burst 20), no Cognito.
- **SES inbound email** — to `dispatch+<deptId>.<sourceId>.<token>@<cadIngressEmailDomain>` (set-up: `docs/runbooks/first-deploy.md` step 9).

Both run **sender authentication first and fail closed**: a message that fails any check never pages anyone, not even as raw text. Radio tone-out (N1.9) is the compensating control for a genuine dispatch dropped that way. Once authenticated, a message always pages: if the source's parser template cannot find the address it pages as raw text, address `SEE DISPATCH TEXT`, flagged VERIFY.

Both write the same `DISPATCH_ALERT` the manual route writes (`sourceSystem: CAD`, `ingressChannel: cad-email | cad-webhook`, `cadSourceId`, `cadParseStatus`, `verifyRequired`), and the table stream's fan-out pages from there. A CAD resend of the same incident number and dispatch time is a duplicate and does not page again.

## Where the configuration lives

| What | Where | Written by |
|---|---|---|
| Sources, sender allowlists, parser templates | platform table `DEPT#<deptId>` / `CONFIG#CAD_INGRESS` | Web: Settings → CAD sources (CHIEF/ADMIN, Cedar `ManageCadIngress`) |
| What ingress reads | alerting table `DEPT#<deptId>#CAD_INGRESS` / `METADATA` (`CAD_INGRESS_COPY`) | `boxalarm-<env>-alerting-cad-source-copy-consumer`, from `platform.config.updated` |
| Webhook HMAC keys `{current, previous}` | Secrets Manager `boxalarm-<env>-cad-webhook-<deptId>-<sourceId>` | `boxalarm-<env>-platform-cad-sources-rotate-key` only |
| Raw inbound mail | `s3://boxalarm-<env>-cad-mail-<account>/inbound/<SES message id>` (SSE-KMS, expires after 30 days) | SES |
| Replay markers | alerting table `DEPT#<deptId>#CAD_REPLAY#<sourceId>#<token>` (TTL 15 min webhook, 24 h email) | the ingress Lambdas |

A saved change reaches ingress in seconds. If `…-alerting-cad-source-copy-dlq-not-empty` fires, ingress is still using the previous sources: read the consumer's logs, fix, redrive the DLQ.

## Checks, in order

**Webhook** (`cadIngress/webhookHandler.ts`): body ≤ 64 KiB (413) → `X-Boxalarm-Source: <deptId>.<sourceId>` is an enabled source with the webhook on and a key → `X-Boxalarm-Timestamp` (Unix seconds) within ±300 s → `X-Boxalarm-Signature: v1=<hex HMAC-SHA256(key, timestamp + "." + raw body)>` matches the current or previous key → the signature has not been seen in the last 15 minutes (409) → parse and write (202, or 200 `duplicate`). Every authentication failure is the same `401` with no detail.

**Email** (`cadIngress/emailHandler.ts`): recipient address names an enabled source with email on and the right token → SES verdicts SPF `PASS`, DKIM `PASS`, spam and virus not `FAIL`, DMARC not `FAIL` → exactly one `From` header holding exactly one mailbox (display names and comments are never read as addresses) → that mailbox is on the allowlist (an address entry matches that address only; a domain entry matches the domain) → DMARC `PASS`, or, when the domain has no usable DMARC result, **every** DKIM `d=` aligned with the From domain → `Date` and each DKIM `t=` within 10 minutes → Message-ID + DKIM signature not seen in 24 h → parse and write.

## Alarms (all to alerting-page; some also to chief-notifications)

| Alarm | Means | Do |
|---|---|---|
| `…-alerting-cad-auth-failed` (3 in 5 min; also chief) | Messages failed authentication and did not page. A forgery attempt, or a genuine source that is misconfigured | Logs: `cadIngress.webhook.authFailed` / `cadIngress.email.quarantined` with `reason`. If it is the real CAD, dispatches are NOT reaching the app: make sure the crew is paged by radio, then fix (below) |
| `…-alerting-cad-quarantined` (also chief) | An email failed authentication and was kept | Read the log line's `quarantine` S3 location. Download with `aws s3 cp` (you need `kms:Decrypt` on `alias/boxalarm-<env>-cad-mail`). Never forward it to the app |
| `…-alerting-cad-replay-rejected` | A webhook signature or email identical to one already written was refused | The replay marker commits in the same transaction as the dispatch, so the original paged. A CAD retry of identical bytes after a timeout, or a replay attack |
| `…-alerting-cad-rejected` | A dependency failed (503 to the CAD, or an email Lambda retry), or a webhook body was too large | The CAD retries a webhook; Lambda retries an email twice. Check the ingress Lambda logs |
| `…-alerting-cad-raw-fallback` (also chief) | A dispatch paged as raw text | The page went. Fix the template: paste the dispatch into Settings → CAD sources → Test parse |
| `…-alerting-cad-webhook-errors` / `-throttles` | The webhook Lambda is failing or at its reserved concurrency (5) | A flood or a retry storm; the API stage throttle is 10 rps. Check `/aws/apigateway/boxalarm-<env>-cad-ingress-api-access` for source IPs |
| `…-alerting-cad-email-failures-not-empty` | An email could not be processed after retries and did not page | The message is in the failure queue and the mail bucket. Fix the dependency. A dispatch older than 10 minutes will now fail freshness; tone it out by radio |

Metrics are in `Boxalarm/alerting-cad-ingress`: `CadIngressAccepted`, `CadIngressAuthFailed` (`Reason`), `CadIngressReplayRejected`, `CadIngressQuarantined`, `CadIngressRejected` (`Reason`), `CadIngressParsed` (`Outcome` = PARSED/RAW), `CadIngressRawFallback`, `CadIngressDuplicate`, each also by `Channel`.

### Common authentication failures

| Reason | Usual cause | Fix |
|---|---|---|
| `UnknownSource` / `UnknownRecipient` | Wrong `X-Boxalarm-Source`, source disabled, webhook off, no key yet; wrong recipient address or token | Compare with Settings → CAD sources |
| `StaleTimestamp` | CAD clock off by more than 5 minutes, or timestamp in milliseconds | NTP on the CAD host; send Unix **seconds** |
| `BadSignature` | Wrong key, or the signature was computed over re-serialized JSON rather than the exact bytes sent | Sign the raw body bytes exactly as sent |
| `NoActiveKey` | The secret has no key (created by hand, or emptied) | Rotate the key from the web app |
| `SpfFailed` / `DkimFailed` / `DmarcFailed` | The CAD's mail is not signed or not sent from an authorized server for its domain; a relay rewrites it | The CAD's mail admin fixes SPF/DKIM, or use the webhook |
| `FromUnparseable` | Two `From` headers, several mailboxes, a group, or an address hidden in a display name | A genuine CAD never does this; treat it as a forgery attempt |
| `SenderNotAllowed` | The From mailbox is not on the allowlist | Add the exact sending address (preferred) or, only if every mailbox of that domain may page the department, the domain |
| `DkimNotAligned` | No DMARC pass and a DKIM `d=` that is not the From domain (a relay adds its own signature) | Have the CAD's domain publish DMARC, or sign with its own domain; never allowlist a relay's domain |
| `RecipientNotSigned` | The department's ingress address is not in the message's DKIM-signed `To` or `Cc` - it was Bcc'd, or a message for another department was redirected here | The CAD must address the department's ingress address in `To` or `Cc`, never `Bcc`. A redirect is an attack or a mistake: it did not page |
| `Stale` | Mail queued more than 10 minutes, or no `Date` header | Fix the CAD's mail queue |

## Rotating a webhook key

Settings → CAD sources → *Rotate webhook key*. The new key is shown **once**. It works **immediately**: a request signed with a key the webhook has not cached yet makes it re-read the secret (at most once every 5 seconds), so there is no 5-minute cache wait. The previous key keeps working too, so the switch-over has no gap:

1. Rotate, and copy the key.
2. The CAD operator installs the new key.
3. Send one test request signed with the new key (test-message procedure below, a negative-safe body on prod is fine: a `200 duplicate` or `202` both prove the signature).
4. Only then consider the old key retired. Rotating twice in a row retires the key the CAD is still using.

If a key leaks: rotate **twice** (the leaked key is then neither current nor previous), then give the CAD the newest key. Until the CAD is updated its requests fail (`BadSignature`) — tone out by radio meanwhile.

## Test-message procedure

A successful test message **pages every eligible member** and starts the tone ladder, exactly like a real call: there is no test flag on this path, on purpose (a test path that differs from the real one proves nothing). So:

- Run positive tests on **dev or qa**, whose departments contain test members only.
- On **prod**, run only the negative tests below, plus Test parse in the web app, unless the chief has scheduled a drill and announced it by radio. For a drill page, use a call type the crew will recognize (`TEST - DISREGARD`), and halt the tone ladder from the officer controls once the page is confirmed.

### Webhook

```
URL=$(pulumi -C infrastructure stack output CAD_WEBHOOK_URL)
SOURCE=nichols-fd.county                      # X-Boxalarm-Source shown when the key was created
read -rs KEY                                  # paste the key; keeps it out of shell history
BODY='{"text":"INC: TEST-0001\nTIME: 00:00\nTYPE: TEST - DISREGARD\nADDR: 1 TEST ST"}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$KEY" -hex | sed 's/^.* //')
curl -sS -X POST "$URL" -H 'content-type: application/json' \
  -H "X-Boxalarm-Source: $SOURCE" -H "X-Boxalarm-Timestamp: $TS" -H "X-Boxalarm-Signature: v1=$SIG" \
  --data-binary "$BODY"
```

Expected, in order:

1. `202 {"status":"accepted","dispatchId":"<deptId>-CAD-…","parse":"PARSED"}` (use labels your template reads; `RAW` means the template did not find the address).
2. Test members' phones page (push and SMS) within seconds; the dispatch shows in the web app's active calls with the parsed address.
3. The same `curl` again, unchanged: `409` and `…-cad-replay-rejected` fires.
4. A fresh timestamp and signature for the same body: `200 {"status":"duplicate"}`, no second page.
5. Negative checks (safe on prod — none of these pages):
   - wrong key (`KEY=$(openssl rand -hex 32)`): `401`, `CadIngressAuthFailed{Reason=BadSignature}`;
   - `TS=$(( $(date +%s) - 301 ))`: `401`, `StaleTimestamp`;
   - `SOURCE=nichols-fd.nope`: `401`, `UnknownSource`.
   Three of these within 5 minutes fire `…-cad-auth-failed`: expected, and it proves the alarm reaches on-call.

### Email

From an account on the source's allowlist, whose domain signs with DKIM and publishes SPF (the CAD itself, ideally), send to the recipient address shown in Settings → CAD sources:

```
Subject: TEST
INC: TEST-0002
TIME: 00:00
TYPE: TEST - DISREGARD
ADDR: 1 TEST ST
```

Expected: test members are paged within a minute; the log has `cadIngress.email.authenticated` then `cadIngress.accepted`; the raw message is at `inbound/<SES message id>` in the mail bucket.

Negative check (safe on prod): send the same text from a personal address that is not on the allowlist. Expected: no page, `cadIngress.email.quarantined` with `reason: SenderNotAllowed`, and `…-cad-quarantined` fires.

## Known limits

- **No test flag.** See above: a CAD test message is a real page.
- **One active SES receipt rule set per account and region.** Activating `boxalarm-<env>-cad-ingress` replaces any other active set in the account.
- **Mail with oversized attachments** (over 10 MiB) is refused (`TooLarge`) rather than paged; CAD dispatch mail is text.
- **Parser patterns** are regular expressions validated on save (no nested quantifiers, at most 200 characters, input capped at 16 KiB); there is no execution timeout.
