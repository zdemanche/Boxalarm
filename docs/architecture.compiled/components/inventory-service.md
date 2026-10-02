# Inventory Service

## Purpose & Boundaries
Equipment registry (F5.1), PPE assignment with NFPA service-life expiry (F5.2), consumable stock/reorder (F5.3), asset lifecycle (F5.4). Wave 4; shares `platform` table. Scheduled stock scan emits reorder events; PPE expiry scanner daily.

## Interfaces
`/api/v1/inventory`: GET/POST `/equipment` (POST admin); GET `/ppe/{memberId}`; GET `/consumables`; PUT `/consumables/{itemId}` (admin; sets `stockLevel`/`reorderThreshold` directly, last-writer-wins, no adjustment ledger); PUT `/equipment/{assetId}/lifecycle` (admin); health pair.

## Data Ownership
EQUIPMENT_ASSET `pk=DEPT#{deptId}#ASSET#{assetId}` `sk=METADATA` (lifecycleStatus ACQUIRED|IN_SERVICE|RETIRED; assignedToType MEMBER|APPARATUS; gsi1 when member-assigned); PPE_ASSIGNMENT `pk=DEPT#{deptId}#MEMBER#{memberId}` `sk=PPE#{ppeItemId}` (status ISSUED|RETIRED|EXPIRED; 10-year `nfpaExpiryDate`; gsi1 `PPE_ASSIGNMENT#{nfpaExpiryDate}`, gsi2 `DEPT#{deptId}#DUE#PPE_ASSIGNMENT#{YYYY-MM}`); CONSUMABLE_STOCK `pk=DEPT#{deptId}#CONSUMABLE#{itemId}` (gsi3 `DEPT#{deptId}#CONSUMABLE`).

## Events Produced
`inventory.expiry.due` (`{memberId, ppeItemId, expiryDate}`; renamed from `ppe.expiry.due`; -> `inventory-notify-queue`); `inventory.reorder.due` (`itemId, itemName, currentQty, reorderThreshold, deptId` -> `inventory-notify-queue`+DLQ).

## Events Consumed
absent — the source document does not address this.

## Dependencies
internal: notification-service, personnel-service, apparatus-service (equipment assignment). external: EventBridge Scheduler.

## Gotchas & Constraints
- Domain prefix `inventory.`, never `ppe.`.
- Whether Valkey is needed for LOB caching at all is an open cost question.

## Source Sections
Backend §1.1 (122-150); §2 inventory-service (490-501); Data Model EQUIPMENT_ASSET..CONSUMABLE_STOCK (1277-1314); Events reconciliation 7 (1640-1647); §4.2 (1883)
