# 2026-09-30: a CAD message for an incident already paged is an update, not a new call

**Status:** decided by the coordinator on the chain review of `feat/cad-ingress` (M2); built on that branch. **Amended 2026-10-14** by the codebase sweep: an update that changes the call now re-emits `dispatch.alert.received` with a revision (rule 3), an update that changes nothing pushes nobody (rule 4), and enabling email and webhook on one source can page twice (rule 8).

**Context:** CAD systems send more than one message per call: added units, a corrected address, "caller reports flames", a re-tone. The first CAD ingress build keyed a dispatch on incident number **plus dispatch time**. That failed both ways:

- An update with the same time was dropped silently as a duplicate. New units and a corrected address reached nobody.
- An update with a new time, which is the common case, became a brand-new dispatch. The whole roster was re-paged at tone 1, a second tone ladder started, and a second incident draft was created.

## The rule

1. **Identity.** When the source's template reads an incident number, the dispatch identity is **source + incident number alone**, held for 24 hours. With no incident number, the identity is the whitespace-insensitive text fingerprint, held for 10 minutes (chain review C1). After the window, the same identity is a new call.
2. **The first message pages**, exactly as before: the same `DISPATCH_ALERT` transaction as the manual path, and the stream fan-out produces tone 1.
3. **A later message for the same incident is an UPDATE.** In one transaction:
   - An immutable `DISPATCH_UPDATE` (`UPDATE#{updateId}`) is written on the dispatch's partition. `updateId` is a hash of the message content, so an identical resend is a duplicate.
   - The `DISPATCH_ALERT` is refreshed where the CAD changed it: type, address, cross streets, units, narrative. It also gets `updateCount`, `lastUpdatedAt` and `cadContentHash`. The refresh is compare-and-set on `updateCount`.
   - When the update changed a field, a `dispatch.alert.received` bridge-outbox row is written with the refreshed fields and a `revision` one past the previous `updateCount`. The LOB plane's dispatch copy upserts by `dispatchId`, and incident-service ignores any revision older than the one it holds, so the incident draft follows the corrected call. The row is an upsert, not a new dispatch, so there is still no second incident draft.
   - The message's replay marker is written.
   - An update is never written as a new dispatch. It does not re-run the tone ladder.
4. **Resends.** A resend of the original message, or of an update already recorded, is a duplicate. Nothing is written and nobody is notified again. `CadIngressDuplicate` is counted and alarmed.
   - **An update that changes nothing** (a resend with a new timestamp, or the same call arriving on the other channel with the same fields) is recorded as a `DISPATCH_UPDATE` and stamped notified, so it is a duplicate next time. It writes no bridge row and pushes nobody. It is counted `CadIngressUnchanged`, which is not alarmed.
   - A remark appended to the text is an update, not an unchanged message.
5. **RAW (fail-open) updates never overwrite a structured address.** An update the template cannot structure only replaces the narrative. A structured update to a RAW call fills in the address and clears `verifyRequired`. An update changes only the fields it carries: a PARSED update with no TYPE line keeps the type already paged.
6. **The crew hears about it with a non-escalating UPDATE push.** It goes to the members already on that dispatch's roster (`ROSTER#`) and to nobody new.
   - Push only: no SMS, no voice, no tone.
   - Delivered as information. On iOS the interruption level is `active` with the default sound. On Android it uses the ordinary channel, not the critical Do Not Disturb-bypass one.
   - Exactly once per update per member, through three guards: a `CADUPDATE#{updateId}#{memberId}#PUSH` claim, a hashed FIFO deduplication id, and the worker's own `CADUPDATE#…#SEND` guard. It never touches a tone's `RECEIPT#`.
7. **Update history.** It is on the dispatch detail: `updates[]`, oldest first, each with what changed from what to what. It shows on the web alert page and the mobile alert screen.
8. **Identity details.**
   - A webhook body that carries structured fields and a `text` key is identified on the rendered structured fields plus the text, so two different no-incident calls with the same text are two calls. Structured-only, text-only and email bodies are identified as before.
   - If the template times out, the incident number is still read from its label rule, so the call keeps its identity and an update is not paged as a new call.
   - **Email and webhook on one source can page twice.** The two channels share an identity only through the incident number or identical text. Collapsing the email copy of a webhook page was tried and removed, because it could merge two different calls; a second page is the safe failure.

## How the UPDATE push is produced

The ingress Lambda asynchronously invokes `boxalarm-<env>-alerting-cad-update-notifier` **after** the update transaction commits and only when the update changed something. Lambda retries it twice, then the alarmed on-failure queue takes it.

It does not read the alerting table stream. That stream already has its two readers (fan-out and the outbox drain), and DynamoDB throttles a third reader per shard. That would slow tone-1 fan-out for every call, which is not an acceptable price for update notices.

**Recovering a lost hand-off.** Each update is written with a pending marker (`DEPT#{deptId}#CAD_UPDATE_PENDING`), and the notifier stamps `notifiedAt` on the update and clears the marker once every member is notified. If the ingress Lambda dies between the commit and the invoke, the update is recorded but not notified. Two things then re-drive it: the sender's retry of the same update (a duplicate of an unnotified update is handed off again), and a 5-minute sweep that re-drives every marker older than 2 minutes. An update still unnotified after 10 minutes raises `…-alerting-cad-update-unnotified` to alerting-page. Re-driving is safe because the per-member claims make a second run send nothing twice.

## Why not

- **Re-page on every update.** Crews already responding would be woken again, every re-tone would start a second ladder, and incident drafts would multiply. Radio already carries "additional units" traffic.
- **Drop updates.** A corrected address that never reaches the app is a crew driving to the wrong building.
- **Include the dispatch time in the identity.** CADs stamp each message with its own time, so this re-pages every update as a new call.

## Reversible how

The identity window (24 h) and the audience (roster only) are constants in `cadIngress/ingest.ts` and `cadIngress/updateNotifierHandler.ts`. Paging SMS for updates would mean adding the SMS channel to the notifier. It deliberately does not do that today.
