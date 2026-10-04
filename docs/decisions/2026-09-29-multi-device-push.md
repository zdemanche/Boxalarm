# 2026-09-29: Multi-device push — the exactly-once key does not change

Context: design review Tier 0 item 4 (`.analysis/design-review/SUMMARY.md`). `registerToken` replaced a member's single PUSH entry, so signing in on a tablet silently stopped paging the member's phone.

## Decision

A member has **one PUSH contact entry per app installation**, and a push page is still **one publish, one receipt, one send guard per member per channel per tone**. The exactly-once key stays `{dispatchId}#{toneSequence}#{memberId}#{channel}` with `channel = push`. The push worker sends that one page to every valid device the member has registered and records each device's outcome on the same guard.

Rejected: adding a device segment to the key (`…#push#{deviceId}`, or `channel = push:{deviceId}`). That would make the producer fan out per device, change the SNS dedup id, the subscription routing value, the receipt shape, and everything that reads receipts (escalation, tone evaluator, delivery baseline, receipt webhooks, self-test). It would also break the invariant that routing and dedup key on `channel` and only `channel`. The device list is resolved by the worker from the eligibility snapshot at send time, so it also covers a device registered after the fan-out.

## How it works

- **Registration** (`personnel-service/pushTokens/pushDevices.ts`). The app sends a stable installation id (`deviceId`, kept in the keychain, `ui/apps/mobile/src/features/alerts/deviceInstallationId.ts`). Registering adds or rotates that device's entry, and replaces any other entry holding the same token. The newest 10 devices are kept. The write is guarded on the member row's `updatedAt`, so two devices registering at once cannot drop each other.
- **Sign-out** sends `DELETE …/push-tokens?deviceId=…` and removes only that device's entry.
- **Backward compatibility.** Existing entries and app builds that send no `deviceId` behave as before: one legacy entry per member, replaced by the next legacy registration and removed by a legacy sign-out. They never disturb identified devices.
- **Projection.** The `personnel.member.updated` event carries every PUSH entry. The alerting consumer copies them into the eligibility snapshot's device group (`eligibility/contactProjection.ts`).
- **Producers** publish push when the member has at least one valid device (`resolvePushTarget`, backed by `resolvePushTargets`).
- **Worker** (`channels/deliverChannelMessage.ts` `deliverPushToDevices`). It sends to every device in parallel under the one guard and records `deviceSends: { [deviceKey]: SENT | VALIDATED | INVALID | REFUSED | UNAVAILABLE | FAILED }` plus `deviceAttempts`. The device key is the `deviceId`, or a token digest for legacy entries. *(Corrected 2026-10-02 — post-merge MAJOR-1 changed the retry rule after this record was written; the architecture's §1.3 multi-device amendment is the current statement.)*
  - If any device accepts, the guard is marked SENT, dead devices are invalidated, and a transiently-failed device is set FAILED and **not retried** — the member already rang, and the redelivery would hold every later member's push in the dispatch's FIFO group.
  - Only when **no** device accepts does a transient failure mark the guard FAILED and rethrow. The redelivery re-sends only to devices with no final outcome, at most `MAX_DEVICE_SEND_ATTEMPTS = 2` per device per page; past that the device is FAILED and terminal (`SendFailed`, alarmed). `UNAVAILABLE` (no gateway credentials for the device's APNs environment) is terminal at once (`PushCredentialsUnavailable`, alarmed).
  - If every device is dead, the page fails terminally, as a single dead token did.
  - If the mass-invalidation latch holds a token valid, the page still throws, redelivers and dead-letters.
- **Invalidation** (`receipts/invalidatePushToken.ts`) marks only the dead token's entry invalid. The member's other devices stay valid.

## Dead tokens (review MINOR-2)

The push worker invalidates a dead token in the alerting snapshot only. The IAM boundary prevents it from writing the personnel member row, so that row still lists the token as valid. Any later registration or sign-out from another of the member's devices re-sends the whole list. The projection (`eligibility/contactProjection.ts` `keepInvalidated`) therefore keeps an invalidated token invalid unless the incoming entry has a newer `registeredAt`, meaning the device really re-registered it. As a result:

- a dead token is not sent again on every page;
- a revived dead token is not counted again toward the mass-invalidation latch.

Trade-off: a dead token still holds one of the 10 device slots on the personnel side until that device registers a new token or signs out, or the member's 10 newer registrations push it out.
