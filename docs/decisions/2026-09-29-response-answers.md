# 2026-09-29: Response answers — ETA, ordering and replays

Context: the mobile alert-screen review (`.analysis/mobile-alert-review.md`, items C–E) on `POST /api/v1/alerting/dispatches/{dispatchId}/responses` (F1.6).

## ETA is optional

The ETA is **not required** for RESPONDING or DIRECT_TO_SCENE.

The architecture asks for "response confirmation … with ETA" (F1.6). Its data model defines `eta` as "Number (minutes, nullable)" on both `DISPATCH_ROSTER_ENTRY` and `DISPATCH_RESPONSE_RECORD`. Nothing in it asks the server to refuse an answer without one.

Refusing costs more than it protects. A 400 on a RESPONDING answer drops the one signal that someone is coming. That can happen from a lock-screen action button, or from any client with no ETA to give. The tone ladder counts answers, not ETAs, so a null ETA never changes whether tone 2 or 3 fires.

- If an ETA is absent or null, it is recorded as `null` and shown as unknown.
- **The unit is the expected arrival time, in epoch seconds.** The only client, the mobile app, sends `now + minutes × 60` (defaulting to 10 minutes) and renders it as a time. The web app does not send or render an ETA.
- A value that is provided must be a whole number no more than an hour in the past and no more than 24 hours ahead. A small number, such as a duration in minutes from a client with the unit wrong, is refused. It is not shown as a time in 1970.
- An ETA is still refused on NOT_RESPONDING.
- `docs/architecture.md` still describes the roster's and response record's `eta` as "minutes". That is left as is because the file is hash-guarded (editing it makes `docs/architecture.compiled/` stale). Fold the correction into the next architecture revision.

## Ordering

The live roster keeps the member's latest answer. "Latest" is decided by `answeredAtMs`, the time the member answered as the client reports it. The server's receipt time breaks a tie.

- `answeredAtMs` is capped at the server clock. It may be at most 24 hours old.
- Every answer is also kept in the append-only record, one item per answer.
- If the roster did not take an answer because a later one is already there, the response is **409 with `code: "SUPERSEDED"`**, not 200. The member must not be told an answer is showing when it is not.

## Replays

The client may send `clientAnswerId`, or the standard `Idempotency-Key` header. A retry with the same id, per member and per dispatch:

- writes nothing new: no second record, no second `alerting.response.confirmed`;
- is answered with the original answer and roster outcome, plus the header `Idempotent-Replayed: true`.

Reusing an id for a different answer is **409 `ANSWER_ID_REUSED`**.
