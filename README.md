# Nichols FD Platform

Fire department management platform. Replacement for Chief360.
Tenant zero: Nichols Fire Department, Trumbull CT 06615.

## Locked decisions

| | |
|---|---|
| **Scope** | Full suite — personnel, training/certs, apparatus & equipment, inventory, inspections & pre-plans, incident reporting. Delivered in dependency waves, not narrowed. |
| **EMS / ePCR** | Out. Fire-only department — no HIPAA, no BAA, no NEMSIS. |
| **Incident reporting** | NERIS (federal). Spec status to be verified before PRD. |
| **Personnel model** | Volunteer roster — response availability, call/drill attendance, points/LOSAP, active-member status. *Assumption — confirm.* |
| **Tenancy** | Single-tenant build, multi-tenant seams called out in the arch doc. |
| **Stack** | AWS serverless, trimmed Moonaan profile: Cognito + API Gateway/Lambda + DynamoDB single-table + Pulumi. **No MFE shell/remote topology** — one React app. |
| **Mobile** | First-class. A volunteer answering a tone-out is on a phone. |
| **GitHub** | Personal `zdemanche`, not the Moonaan org. Transfer later if it makes sense. |
| **Jira** | Personal site under `zachdemanche@gmail.com`, auth via `jira.py` env vars (not the Atlassian MCP). |

## Process

Moonaan SDLC: PRD → `/sdlc:generate-architecture` → `/sdlc:arch-compile` → `/sdlc:generate-backlog` → `/sdlc:generate-code` per story.

## Repos (created at code time, under `zdemanche`)

`fd-ui` · `fd-backend` · `fd-infrastructure`

## Layout

- `docs/` — PRD, architecture, research notes
