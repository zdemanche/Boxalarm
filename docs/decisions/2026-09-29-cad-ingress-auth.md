# 2026-09-29: CAD ingress authentication — sender auth first, fail closed

**Status:** decided; binding on the CAD ingress build. Built on `feat/cad-ingress` (operations and the test-message procedure: `docs/runbooks/cad-ingress.md`). Tightened over the text below by the security review: the From header is parsed by the RFC 5322 grammar (exactly one header, exactly one mailbox; display names and comments are never read as addresses); an address allowlist entry matches that address only, never its domain; and alignment is required - DMARC `PASS`, or, when the domain has no usable DMARC result, every DKIM `d=` aligned with the From domain (SES reports one DKIM verdict for the whole message, so a foreign signature must not be present at all).
**Context:** `2026-09-29-roadmap-defaults.md` #3 picked two deterministic CAD ingress paths: SES inbound email and a signed JSON webhook. It says the parser "fails open to raw text". Security review M7 (`.analysis/design-review/security-data.md`) points out two attacks:
- A spoofed email to the ingress address pages the whole volunteer force to a fake address.
- A replayed webhook re-pages an old call. Dispatch dedup only helps when the same external ID is reused.

The existing vendor-receipt webhook (`alerting-service/receipts/vendorAuth.ts`) uses a static shared secret with no replay protection. It is **not** the model for CAD ingress.

## The rule

1. **Authenticate the sender before parsing anything.** Signature, DKIM/SPF and allowlist checks run on the raw bytes and envelope. No field of an unauthenticated message is read, logged in full, or used to route.
2. **Fail closed on authentication failure.** An unauthenticated message never pages anyone, not even as "raw text". It is dropped. The drop is counted, alarmed, and kept (quarantined) for review.
3. **"Fail open to raw text" applies only after authentication succeeds.** An authenticated message that the source's parser cannot structure still pages, with the raw text. That fallback exists for parser failures, not for trust failures.
4. **The department comes from the authenticated source's configuration, never from the message.** A `deptId`, address, or header inside the body cannot choose the tenant.

A dropped *genuine* dispatch is covered by N1.9: parallel radio tone-out is retained and is the compensating control. That is why failing closed is acceptable here. A forged page, by contrast, has no compensating control.

## Email path (SES inbound)

**Accept only when all of these hold:**
- The SES receipt event's `receipt.dkimVerdict.status` is `PASS`.
- `receipt.spfVerdict.status` is `PASS`.
- `receipt.virusVerdict.status` is not `FAIL`.
- The DKIM signing domain (`d=`) and the RFC 5322 `From` domain are both in that source's **sender allowlist**, a per-department list stored in `DEPARTMENT_CONFIG` (CAD ingress config type). Requiring `d=` to match is what stops a message that is signed by *some* domain while showing an allowlisted `From`.
- `receipt.dmarcVerdict.status` is recorded. It is required when the sender domain publishes a DMARC policy.

**Recipient address.** Each department has its own address, with a random token in the local part (`dispatch+<token>@<ingress-domain>`). The token only cuts noise. It is **not** authentication, because anyone who has seen one page email knows it.

**Replay and duplicates:**
- Before paging, do a conditional put (`attribute_not_exists`) keyed on the RFC 5322 `Message-ID` plus the DKIM `b=` signature hash, with a TTL of 24 h. The SES `messageId` alone is not enough, because a re-sent copy gets a new one.
- Reject any message whose DKIM `t=` or `Date` header is more than 10 minutes old.

**A CAD that cannot pass DKIM+SPF cannot use this path.** For example, a county relay that rewrites or does not sign mail. Put a relay that signs in front of it, or use the webhook. There is no allowlist-only mode, because a `From` header on its own is trivially forged.

## Webhook path (signed JSON)

**Headers:**
- `X-Boxalarm-Source: <sourceId>` selects the source config: department, secret ARN and parser.
- `X-Boxalarm-Timestamp: <unix seconds>`
- `X-Boxalarm-Signature: v1=<hex>[, v1=<hex>]`

**Signature:** `HMAC-SHA256(secret, timestamp + "." + rawBody)`, hex-encoded.
- Compute it over the **raw request bytes**. Base64-decode when API Gateway sets `isBase64Encoded`. Never compute it over re-serialized JSON.
- Compare in constant time (`timingSafeEqual` on equal-length digests).
- Accept the request if any listed signature matches either active key.

**Secrets:**
- One secret per source, in Secrets Manager, holding **two active keys** (`current`, `previous`) for rotation without downtime.
- Cache the secrets in the Lambda for at most 5 minutes.

**Freshness:** reject the request if `|now - timestamp| > 300 s`.

**Replay cache:** on the alerting table, do a conditional put `DEPT#{deptId}#CAD_REPLAY#{sourceId}#{signatureHex}` with `attribute_not_exists(pk)` and a `ttl` of now + 900 s. The TTL must be more than twice the freshness window, so every request inside the window is still cached. If the conditional put fails, the request is a replay: return 409 and do not page.

**Order of checks:**
1. Source lookup
2. Timestamp window
3. Signature
4. Replay put
5. Only then `JSON.parse` and the parser

A failure at any of steps 1–4 returns `401` or `409` with a generic body. It emits `CadIngressAuthFailed{Reason}` and does not echo which check failed.

**Routing:** the webhook is an unauthenticated route, as far as Cognito is concerned. It must get its own route with its own throttle, and ideally its own stage, so that:
- A flood against it cannot consume the M4-reserved dispatch/respond capacity.
- A flood elsewhere cannot starve it.

`HttpApi.authorizedRoute` forbids open routes on purpose. Wire the webhook the way the receipt webhooks are wired (`AlertingRoute` with `authorized: false`), with a route-level throttle added.

## Observability and tests

**Alarms:**
- `CadIngressAuthFailed` over a small threshold, to the chief and the platform operator.
- Any `CadIngressReplayRejected`.
- A quarantine count above zero.

These are also how a misconfigured genuine source gets noticed before N1.9 is the only thing paging.

**Required tests** (no source ships without them):
- A forged `From` with DKIM `PASS` for another domain does not page.
- SPF `FAIL` does not page.
- A body carrying a different `deptId` pages only the configured department.
- A webhook signed with the wrong key does not page.
- A webhook with a stale timestamp (301 s) does not page.
- An identical request replayed inside the window does not page.
- Rotation: a request signed with the previous key still passes.
- A request whose body was re-serialized fails the signature.
- An authenticated but unparseable message pages with raw text.
