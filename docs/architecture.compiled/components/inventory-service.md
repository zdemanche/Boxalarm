# inventory-service

## Purpose & Boundaries
Equipment/PPE registry, consumable stock, asset lifecycle. Wave 4. Data on the shared `platform-service` table.

## Interfaces
Base path `/api/v1/inventory/...`.

| Method | Path | Description | Auth |
|---|---|---|---|
| GET | `/equipment` | Equipment registry (F5.1) | Cognito |
| POST | `/equipment` | Register equipment | Cognito(admin) |
| GET | `/ppe/{memberId}` | PPE assignment, sizes, NFPA service-life expiry (F5.2) | Cognito |
| GET | `/consumables` | Stock levels + reorder thresholds (F5.3) | Cognito |
| PUT | `/equipment/{assetId}/lifecycle` | Acquisition/service/retirement transition (F5.4) | Cognito(admin) |

## Data Ownership
On the shared `platform-service` table.

- **EQUIPMENT_ASSET (F5.1)** — `pk=DEPT#{deptId}#ASSET#{assetId}`, `sk=METADATA`. `assignedToType` MEMBER|APPARATUS. `lifecycleStatus` ACQUIRED|IN_SERVICE|RETIRED. `gsi1pk/sk` (when assigned to a member) = `MEMBER#{memberId}` / `EQUIPMENT_ASSET#{assetId}`.
- **PPE_ASSIGNMENT (F5.2)** — `pk=DEPT#{deptId}#MEMBER#{memberId}`, `sk=PPE#{ppeItemId}`. `nfpaExpiryDate` = 10-year NFPA service life. `gsi1pk/sk` and `gsi2pk/sk` (due-window) both present.
- **CONSUMABLE_STOCK (F5.3)** — `pk=DEPT#{deptId}#CONSUMABLE#{itemId}`, `sk=METADATA`. `stockLevel`/`reorderThreshold`.

## Events Produced
- `ppe.expiry.due` — PPE Expiry Scanner (daily scheduled Lambda). `{memberId, ppeItemId, expiryDate}`. Consumer: `notification-service`. Transport: `boxalarm-{env}-platform-bus` → `inventory-notify-queue` + DLQ.
- `inventory.reorder.due` — inventory-service scheduled stock scan (F5.3). `{itemId, itemName, currentQty, reorderThreshold, deptId}`. Consumer: `notification-service` (routes to quartermaster/admin role). Transport: platform-bus → `inventory-notify-queue` + DLQ.

## Events Consumed
None named.

## Dependencies
**Internal:** publishes to `notification-service` (PPE expiry, reorder threshold).
**External:** none.

## Gotchas & Constraints
- **Consumable stock-below-threshold query is a small-item-count filter scan**, not a GSI-indexed access pattern — `FilterExpression stock vs threshold` over GSI3 `DEPT#{deptId}#CONSUMABLE`, acceptable only because item counts are small.
- Both `ppe.expiry.due` and `inventory.reorder.due` route through `notification-service`'s digest-batching obligation — do not assume per-event immediate delivery from this service's side.
- No TTL specified for equipment/PPE/consumable records — current-state records deleted explicitly on business action (retirement/decommission), never by time.

## Source Sections
- Backend §1.1 Bounded contexts / service table — lines 116–142
- API endpoints: inventory-service — lines 376–385
- Data Model §3.3 EQUIPMENT_ASSET, PPE_ASSIGNMENT, CONSUMABLE_STOCK — lines 1033–1071
- Data Model §3.4 Retention/TTL — lines 1164–1175
- Data Model §4 Access pattern #35–36 — lines 1217–1218
- Events §5 Producer/consumer table (ppe.expiry.due) — lines 1503–1522
- Events §7 New notification-service events (inventory.reorder.due) — lines 1337–1345
- Testing §2 F5 test matrix — lines 1950–1954
