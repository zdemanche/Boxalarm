# inventory-service

## Purpose & Boundaries
Equipment/PPE registry, consumable stock levels, and asset lifecycle tracking.

## Interfaces
Base path `/api/v1/inventory/...`.

| Method | Path | Auth |
|---|---|---|
| GET / POST | `/equipment` | Cognito / Cognito(admin) |
| GET | `/ppe/{memberId}` (assignment, sizes, NFPA service-life expiry) | Cognito |
| GET | `/consumables` (stock + reorder thresholds) | Cognito |
| PUT | `/equipment/{assetId}/lifecycle` | Cognito(admin) |

## Data Ownership
On the shared `platform-service` table:
- `EQUIPMENT_ASSET` - `pk=DEPT#{deptId}#ASSET#{assetId}`, `assignedToType: MEMBER|APPARATUS`, `lifecycleStatus: ACQUIRED|IN_SERVICE|RETIRED`.
- `PPE_ASSIGNMENT` - `sk=PPE#{ppeItemId}`, `nfpaExpiryDate` (10-year NFPA service life), GSI2 due-date bucketing.
- `CONSUMABLE_STOCK` - `pk=DEPT#{deptId}#CONSUMABLE#{itemId}`, `stockLevel`/`reorderThreshold`.

## Events Produced
- `ppe.expiry.due` (daily scheduled scanner) -> `notification-service`.
- `inventory.reorder.due` (amendment, previously undefined; scheduled stock scan) -> `notification-service` (routes to quartermaster/admin role). Payload: `itemId, itemName, currentQty, reorderThreshold, deptId`.

## Events Consumed
None specific.

## Dependencies
- Internal: `notification-service` (PPE-expiry and reorder-threshold delivery).
- External: none named.

## Gotchas & Constraints
- `inventory.reorder.due` is one of the two amendment events this section's original text routed to `notification-service` without ever defining - now formally specified with its own `boxalarm-{env}-platform-bus` rule -> `inventory-notify-queue` + DLQ.

## Source Sections
- Backend section 1.1 Bounded contexts (service #9), lines 118-142
- API endpoints, inventory-service, lines 399-408
- Data Model section 3.3 EQUIPMENT_ASSET, PPE_ASSIGNMENT, CONSUMABLE_STOCK, lines 1137-1174
- Eventing section 1 reconciliation item 7 (inventory.reorder.due newly defined), lines 1449-1456
- Testing section 2 F5 matrix, lines 2144-2148
