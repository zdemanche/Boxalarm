# UI Shared Packages

## Purpose & Boundaries
Three internal TypeScript npm-workspace packages consumed by web-console and mobile-app, not published to `@moonaan` (single-consumer): `@boxalarm/core` (domain types, generated API client, NERIS enum validation, offline sync-queue engine), `@boxalarm/design-tokens` (color/spacing/type scale as CSS custom properties on web and a theme object on RN; includes daylight and dark-cab palettes), `@boxalarm/i18n` (i18next resource bundles). Components are NOT shared between web and RN.

## Interfaces
Workspace layout `apps/web`, `apps/mobile`, `packages/core`, `packages/design-tokens`, `packages/i18n` (Yarn/npm workspaces; no Nx/Turborepo). Generated API client matches backend routes; drift caught by `infrastructure/test/api/ui-route-contract.test.ts`.

## Data Ownership
absent — the source document does not address this.

## Events Produced
absent — the source document does not address this.

## Events Consumed
absent — the source document does not address this.

## Dependencies
internal: web-console, mobile-app (consumers). external: i18next, react-i18next, @tanstack/react-query, jotai.

## Gotchas & Constraints
- Sync engine lives in core regardless of op-sqlite vs WatermelonDB; each outbox entry carries a client-generated idempotency key; shift claims queued as pending until confirmed.
- Tokens shared as raw values only.
- NERIS validation must use the same coded projection the server sends.

## Source Sections
Frontend §2 shared (1988-1999); §3 (2030-2037); §6 (2115-2139); §9 (2183-2191)
