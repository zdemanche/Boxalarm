# Inventory Service

## Purpose & Boundaries
Equipment registry (F5.1), PPE assignment + NFPA expiry (F5.2), consumable stock/reorder (F5.3), asset lifecycle (F5.4). Platform table.

## Interfaces
`/api/v1/inventory`: GET/POST `/equipment` (POST admin); GET `/ppe/{memberId}`; GET `/consumables`; PUT `/consumables/{itemId}` (admin; sets `stockLevel`/`reorderThreshold` directly, last-writer-wins, no ledger); PUT `/equipment/{assetId}/lifecycle` (admin); health pair.

## Data Ownership
`EQUIPMENT_ASSET` (`pk=DEPT#{d}#ASSET#{assetId}`; lifecycleStatus ACQUIRED|IN_SERVICE|RETIRED; assignedToType MEMBER|APPARATUS; gsi1 when member-assigned), `PPE_ASSIGNMENT` (`pk=DEPT#{d}#MEMBER#{m}`, `sk=PPE#{ppeItemId}`; `nfpaExpiryDate` 10-year life; status ISSUED|RETIRED|EXPIRED; gsi1, gsi2 `DEPT#{d}#DUE#PPE_ASSIGNMENT#{YYYY-MM}`), `CONSUMABLE_STOCK` (`pk=DEPT#{d}#CONSUMABLE#{itemId}`; gsi3 `DEPT#{d}#CONSUMABLE`).

## Events Produced
`inventory.expiry.due` `{memberId, ppeItemId, expiryDate}` (daily PPE scanner) -> `inventory-notify-queue`; `inventory.reorder.due` `{itemId, itemName, currentQty, reorderThreshold, deptId}` (scheduled stock scan) -> `inventory-notify-queue`.

## Events Consumed
absent — the source document does not address this

## Dependencies
internal: notification-service. external: DynamoDB.

## Gotchas & Constraints
- Event names renamed from `ppe.expiry.due` (N-5).
- Reorder check filters stock vs threshold app-side over small item count.
- Test matrix F5.3n (reorder notification delivered).

## Source Sections
§1.1 122–150; §2 inventory API 490–501; Data Model EQUIPMENT_ASSET..CONSUMABLE 1277–1314; Events item 7 1640–1647; Testing F5 2359–2363.
