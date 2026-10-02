# Training Service

## Purpose & Boundaries
Certifications (F3.1), expiry alerting with configurable lead time (F3.2), drill/training events and sign-up/attendance (F3.3-3.4), ISO-aligned hour reports (F3.5), exportable transcripts (F3.6); expired cert lowers qualification eligibility (F3.7). Wave 3; shares `platform` table. Cert expiry scanner is a daily scheduled Lambda in this service.

## Interfaces
`/api/v1/training`: GET `/members/{memberId}/certifications`; POST `/members/{memberId}/certifications` (admin, incl. attachment); GET `/certifications/expiring` (admin); GET `/events`; POST `/events/{eventId}/signup`; GET `/hours`; GET `/reports/iso` (admin); GET `/members/{memberId}/transcript`; health pair. Cert revocation route registered but untabulated.

## Data Ownership
CERTIFICATION `pk=DEPT#{deptId}#MEMBER#{memberId}` `sk=CERT#{certId}` (status CURRENT|EXPIRED|REVOKED; `attachmentS3Key` PII; gsi1 `MEMBER#{memberId}`/`CERTIFICATION#{expiryDate}`; gsi2 `DEPT#{deptId}#DUE#CERTIFICATION#{YYYY-MM}`/`{expiryDate}#{certId}`); TRAINING_EVENT `pk=DEPT#{deptId}#TRAINING_EVENT#{eventId}` `sk=METADATA` (gsi3 `DEPT#{deptId}#TRAINING_EVENT`/`{startAt}`); TRAINING_ATTENDANCE `sk=ATTENDEE#{memberId}` (hours, denormalized category; gsi1 `TRAINING_ATTENDANCE#{eventStartAt}`). MEMBER_QUALIFICATION.grantedByCertId/currentlyEligible is derived from cert currency. S3 `{deptId}/cert/{certId}/...`.

## Events Produced
`training.expiry.due` (`{memberId, certId, expiryDate, leadDays}`; renamed from `cert.expiry.due`; daily scanner -> `training-notify-queue`).

## Events Consumed
absent — the source document does not address this.

## Dependencies
internal: notification-service (consumer), personnel-service (quals), reporting-service. external: S3, EventBridge Scheduler.

## Gotchas & Constraints
- Domain prefix must be `training.` not `cert.`; PascalCase `CertExpiring` never appears in code.
- Expiry notifications are digest-batched per member per category per day by notification-service.
- Scanned cert card is PII (full name, DOB).

## Source Sections
Backend §1.1 (122-150); §2 training-service (441-454); Data Model CERTIFICATION/TRAINING (1052-1067, 1146-1166); Events §4.2/§5 (1881, 1903); Testing F3 (2333-2343)
