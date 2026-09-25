# inventory-service

## Purpose & Boundaries

Equipment/PPE registry, consumable stock, asset lifecycle. Service 9 of 10, Wave 4. Logical service on the shared `platform-service` physical table.

## Interfaces

Base path `/api/v1/inventory/...`.

| Method | Path | Description | Auth |
|---|---|---|---|
| GET | `/equipment` | Equipment registry (F5.1) | Cognito |
| POST | `/equipment` | Register equipment | Cognito(admin) |
| GET | `/ppe/{memberId}` | PPE assignment, sizes, NFPA service-life expiry (F5.2) | Cognito |
| GET | `/consumables` | Stock levels + reorder thresholds (F5.3) | Cognito |
| PUT | `/consumables/{itemId}` | Adjust stock level / reorder threshold (N-9, decided) — last-writer-wins direct set, no adjustment-history entity | Cognito(admin) |
| PUT | `/equipment/{assetId}/lifecycle` | Acquisition/service/retirement transition (F5.4) | Cognito(admin) |
| GET | `/health/liveness` \| `/health/readiness` | Health | none |

## Data Ownership

On `platform-service` physical table.

- **EQUIPMENT_ASSET** — `pk=DEPT#{deptId}#ASSET#{assetId}`, `sk=METADATA`. `assignedToType`: `MEMBER`|`APPARATUS`. `lifecycleStatus`: `ACQUIRED`|`IN_SERVICE`|`RETIRED`.
- **PPE_ASSIGNMENT** — `pk=DEPT#{deptId}#MEMBER#{memberId}`, `sk=PPE#{ppeItemId}`. `nfpaExpiryDate` (10-year NFPA service life). GSI2 due-dates.
- **CONSUMABLE_STOCK** — `pk=DEPT#{deptId}#CONSUMABLE#{itemId}`, `sk=METADATA`. `stockLevel`/`reorderThreshold`.

## Events Produced

- `inventory.expiry.due` (canonical name; renamed from `ppe.expiry.due` — domain-is-owning-service convention: inventory-service owns PPE per §1.1) — daily scheduled PPE Expiry Scanner → `notification-service`.
- `inventory.reorder.due` — scheduled stock scan (F5.3) → `notification-service` (routes to quartermaster/admin role). Transport: `boxalarm-{env}-platform-bus` → `inventory-notify-queue` + DLQ. Payload: `itemId`, `itemName`, `currentQty`, `reorderThreshold`, `deptId`.

## Events Consumed

None named directly.

## Dependencies

**Internal:** `notification-service` (expiry/reorder routing).

**External:** none named beyond shared S3/DynamoDB infra.

## Gotchas & Constraints

- **Event rename is canonical:** `ppe.expiry.due` → `inventory.expiry.due` for the same domain-ownership reason as `training.expiry.due`'s rename — the old SNS topic name already agreed with the new event name, which was the original tell that the event name itself was wrong.
- **`inventory.reorder.due` was previously undefined** and had no notification-service routing — now fully specified (producer/consumer/transport/payload).
- **Stock adjustment is last-writer-wins, not an append-only ledger** — no adjustment-history entity exists in the data model; `PUT /consumables/{itemId}` sets `stockLevel`/`reorderThreshold` directly, same as every other current-state PUT in this table.

## Source Sections

- Backend §1.1 Service inventory (`:120-146`)
- Backend §1.4 Event naming reconciliation, `ppe.expiry.due` correction (`:262-264`)
- Backend §2 inventory-service API endpoints (`:418-429`)
- Data Model §3.3 EQUIPMENT_ASSET, PPE_ASSIGNMENT, CONSUMABLE_STOCK (`:1190-1227`)
- Data Model §4 Access patterns 35-36 (`:1402-1403`)
- Events §7 new events table, `inventory.reorder.due` (`:1548-1556`)
- Events §Other domains, `inventory.expiry.due` (`:1787-1817`)
