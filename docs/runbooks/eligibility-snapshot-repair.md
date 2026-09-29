# Eligibility snapshot repair: `alerting-member-updated-dlq-not-empty`

The alerting plane pages from `MEMBER_ELIGIBILITY_SNAPSHOT` (`DEPT#{deptId}#ELIGIBILITY` / `MEMBER#{memberId}` in the alerting table). That snapshot is built from `personnel.member.updated` events by the member-updated consumer. A message in `boxalarm-{env}-alerting-member-updated-dlq` is a member change that never reached paging. It could be a retirement, an LOA, a phone change, a new device or a role change.

## Do not redrive a DLQ that holds events from before fix/page-chain

Before fix/page-chain, every `personnel.member.updated` event failed with a DynamoDB ValidationException (the reserved word `roles`), so that DLQ can hold weeks of stale member changes. Do not redrive them.

- A redriven event is an old snapshot of the member, delivered now. Each field is guarded by its own clock (`activeUpdatedAt`, `availabilityUpdatedAt`, `qualsUpdatedAt`, `rolesUpdatedAt`, `pushContactsUpdatedAt`, `phoneUpdatedAt`), so an old event cannot overwrite a newer one.
- It can still re-apply an old value to any field that has not changed since. For example, a push-device list from before a device was replaced.
- The authoritative state is the personnel member row. Re-emit that instead.

## Re-emit the member's current state

For each affected member (the `memberId` in each DLQ message's `detail.payload`):

1. Read the member row from the platform table: `pk = DEPT#{deptId}#MEMBER#{memberId}`, `sk = METADATA`.
2. Write one `OUTBOX_ENTRY` to the platform table with the current state. The platform outbox publisher picks up the INSERT and publishes it with `source: personnel-service`.

   ```json
   {
     "pk": "DEPT#{deptId}#OUTBOX#{memberId}",
     "sk": "EVT#{new uuid}",
     "entityType": "OUTBOX_ENTRY",
     "eventId": "{same uuid}",
     "eventTime": "{now, ISO 8601}",
     "eventType": "personnel.member.updated",
     "source": "personnel-service",
     "correlationId": "{memberId}",
     "schemaVersion": "1.0",
     "sentAt": null,
     "payload": {
       "deptId": "{deptId}",
       "memberId": "{memberId}",
       "active": "{see below}",
       "status": "{status}",
       "roles": ["{roles}"],
       "phone": "{phone, E.164}",
       "contactChannels": ["{the row's PUSH entries, as stored}"]
     }
   }
   ```

   For `active`, send what a status change sends: `true` when `status` is `ACTIVE`, and `false` otherwise. The exception is a member still at the PROBATIONARY status given at creation, with no status change since. Omit `active` for them. Creation never sends it, and the snapshot seeds a new member as active.
3. Confirm in the alerting table that the member's snapshot now shows the row's values.
4. Purge the DLQ messages you replaced.

An event emitted now carries the current time. That time is newer than every clock on the snapshot, so every field it carries is applied.
