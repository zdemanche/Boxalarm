# Training Service

## Purpose & Boundaries
Certifications (F3.1), expiry alerting via scanner (F3.2), drills/training events and attendance (F3.3), training hours (F3.4), ISO-aligned report (F3.5), transcripts (F3.6), expired cert -> qualification eligibility (F3.7). Platform table.

## Interfaces
`/api/v1/training`: GET `/members/{memberId}/certifications`; POST same (admin, incl. attachment); GET `/certifications/expiring` (admin, configurable lead time); GET `/events`; POST `/events/{eventId}/signup`; GET `/hours`; GET `/reports/iso` (admin); GET `/members/{memberId}/transcript`; health pair. Unlisted but built: cert revocation, attendance reads.

## Data Ownership
`CERTIFICATION` (`pk=DEPT#{d}#MEMBER#{m}`, `sk=CERT#{certId}`; status CURRENT|EXPIRED|REVOKED; `attachmentS3Key` PII; gsi1 `MEMBER#{m}`/`CERTIFICATION#{expiryDate}`; gsi2 `DEPT#{d}#DUE#CERTIFICATION#{YYYY-MM}`/`{expiryDate}#{certId}`), `TRAINING_EVENT` (`pk=DEPT#{d}#TRAINING_EVENT#{eventId}`, METADATA; gsi3 `DEPT#{d}#TRAINING_EVENT`/`{startAt}`), `TRAINING_ATTENDANCE` (`ATTENDEE#{memberId}`; denormalized category; gsi1 `MEMBER#{m}`/`TRAINING_ATTENDANCE#{eventStartAt}`). Shares `MEMBER_QUALIFICATION.currentlyEligible` derived from cert.

## Events Produced
`training.expiry.due` `{memberId, certId, expiryDate, leadDays}` (daily scanner) -> `training-notify-queue`.

## Events Consumed
absent — the source document does not address this

## Dependencies
internal: personnel-service (quals), notification-service. external: S3 (cert attachments).

## Gotchas & Constraints
- Event renamed from `cert.expiry.due` (N-5): use `training.expiry.due` only.
- Attachment scans show name/DOB -> PII.
- Expiry scanner emits one event per item; notification-service must digest per member/category/day.
- Test matrix needs F3.2n row (notification delivered to member + training officer).

## Source Sections
§1.1 122–150; §2 training API 441–454; Data Model CERTIFICATION 1052–1066, TRAINING 1146–1166; AP 23–26 1480–1483; Testing F3 2333–2343.
