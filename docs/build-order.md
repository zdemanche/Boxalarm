# Boxalarm — Build Order

8 epics · 90 stories · 13 dependency waves · 160 edges · no cycles

> **A wave is a feasibility bound, not a shippable release.** Each story sits at the earliest
> point its dependencies allow. Priority ordering is layered on top — see *Release framing* below.

## Epics

- [**E1**](https://github.com/zdemanche/boxalarm-docs/issues/14) — A volunteer never misses the call for duty
- [**E2**](https://github.com/zdemanche/boxalarm-docs/issues/32) — The roster always reflects who can respond, with what, and when
- [**E3**](https://github.com/zdemanche/boxalarm-docs/issues/44) — No one's certification lapses without warning
- [**E4**](https://github.com/zdemanche/boxalarm-docs/issues/53) — Apparatus, PPE, and equipment are always known to be in-service or not
- [**E5**](https://github.com/zdemanche/boxalarm-docs/issues/68) — The pre-plan and the hydrant are one tap away when it matters
- [**E6**](https://github.com/zdemanche/boxalarm-docs/issues/77) — The incident report writes most of itself and clears NERIS the first time
- [**E7**](https://github.com/zdemanche/boxalarm-docs/issues/90) — Compliance and grant reports come out of the system instead of into a spreadsheet
- [**E8**](https://github.com/zdemanche/boxalarm-docs/issues/100) — The department can run, secure, and own its own platform without a vendor on call

## Waves

### Wave 1  (8 stories)

- [E1-S16](https://github.com/zdemanche/boxalarm-docs/issues/30) — Resolve CAD integration surface and obtain dispatch-authority authorization
- [E6-S12](https://github.com/zdemanche/boxalarm-docs/issues/89) — NERIS Integration Partner vendor onboarding and compatibility check
- [E6-S7](https://github.com/zdemanche/boxalarm-backend/issues/105) — NERIS environment configuration and OAuth2 client-credentials integration
- [E8-S1](https://github.com/zdemanche/boxalarm-backend/issues/118) — Cross-platform sign-in, no MFA
- [E8-S11](https://github.com/zdemanche/boxalarm-backend/issues/127) — Platform-wide observability foundation: structured logging, tracing, metrics (N8.1)
- [E8-S5](https://github.com/zdemanche/boxalarm-backend/issues/122) — Tamper-evident audit log for every record mutation
- [E8-S7](https://github.com/zdemanche/boxalarm-backend/issues/124) — Department-scoping tenancy seam across the data model
- [E8-S9](https://github.com/zdemanche/boxalarm-backend/issues/126) — Records retention configuration and verified disposal

### Wave 2  (3 stories)

- [E8-S10](https://github.com/zdemanche/boxalarm-infrastructure/issues/5) — Assert U.S.-only data residency and encryption posture in CI (N6.1, N5.1)
- [E8-S3](https://github.com/zdemanche/boxalarm-backend/issues/120) — Role-based authorization via Verified Permissions (Cedar)
- [E8-S8](https://github.com/zdemanche/boxalarm-backend/issues/125) — Session policy and token revocation

### Wave 3  (11 stories)

- [E1-S1](https://github.com/zdemanche/boxalarm-backend/issues/43) — Manual dispatch entry adapter (degraded-mode fallback)
- [E2-S1](https://github.com/zdemanche/boxalarm-backend/issues/58) — Member roster CRUD with status lifecycle
- [E2-S7](https://github.com/zdemanche/boxalarm-backend/issues/64) — Duty shift definition with required positions and quals
- [E4-S1](https://github.com/zdemanche/boxalarm-backend/issues/77) — Apparatus registry with in/out-of-service status
- [E4-S11](https://github.com/zdemanche/boxalarm-backend/issues/87) — Equipment/asset registry with serial numbers, assignment, and location
- [E5-S1](https://github.com/zdemanche/boxalarm-backend/issues/91) — Occupancy records: create, view, edit
- [E5-S3](https://github.com/zdemanche/boxalarm-backend/issues/93) — Hydrant registry: location, size, flow, last test, out-of-service
- [E6-S1](https://github.com/zdemanche/boxalarm-backend/issues/99) — NERIS-native incident data model with opaque versioned payloads
- [E8-S2](https://github.com/zdemanche/boxalarm-backend/issues/119) — Self-service, reliable credential recovery
- [E8-S4](https://github.com/zdemanche/boxalarm-backend/issues/121) — Department configuration management
- [E8-S6](https://github.com/zdemanche/boxalarm-backend/issues/123) — Full department data export

### Wave 4  (19 stories)

- [E1-S14](https://github.com/zdemanche/boxalarm-backend/issues/55) — Register and rotate device push tokens
- [E2-S2](https://github.com/zdemanche/boxalarm-backend/issues/59) — Qualifications and quals-based eligibility
- [E2-S3](https://github.com/zdemanche/boxalarm-backend/issues/60) — Attendance capture across calls, drills, meetings, work details, and standby
- [E2-S5](https://github.com/zdemanche/boxalarm-backend/issues/62) — Planned unavailability (marking off) that suppresses alerting
- [E2-S6](https://github.com/zdemanche/boxalarm-backend/issues/63) — Member self-service profile and contact update
- [E2-S8](https://github.com/zdemanche/boxalarm-backend/issues/65) — Atomic open-shift signup with offline-pending claim handling
- [E3-S1](https://github.com/zdemanche/boxalarm-backend/issues/69) — Certification records with issuing authority and attachments
- [E3-S4](https://github.com/zdemanche/boxalarm-backend/issues/72) — Drill and training event scheduling with member sign-up
- [E4-S14](https://github.com/zdemanche/boxalarm-backend/issues/90) — Asset lifecycle: acquisition through retirement
- [E4-S2](https://github.com/zdemanche/boxalarm-backend/issues/78) — Configurable per-apparatus check-sheet templates
- [E4-S5](https://github.com/zdemanche/boxalarm-backend/issues/81) — Out-of-service tracking with reason, duration, and availability impact
- [E4-S6](https://github.com/zdemanche/boxalarm-backend/issues/82) — Maintenance history and scheduled maintenance
- [E4-S9](https://github.com/zdemanche/boxalarm-backend/issues/85) — Compartment inventory per apparatus
- [E5-S2](https://github.com/zdemanche/boxalarm-backend/issues/92) — Pre-incident plans with attachments, site diagrams, and utility shutoffs
- [E5-S5](https://github.com/zdemanche/boxalarm-backend/issues/95) — Inspection scheduling, conduct, and violation tracking
- [E5-S6](https://github.com/zdemanche/boxalarm-backend/issues/96) — Map-based retrieval of occupancies and hydrants
- [E6-S10](https://github.com/zdemanche/boxalarm-backend/issues/108) — Incident search and history
- [E6-S11](https://github.com/zdemanche/boxalarm-backend/issues/109) — Schema-version independence — NERIS schema updates without a data-model redeploy
- [E6-S4](https://github.com/zdemanche/boxalarm-backend/issues/102) — Incident narrative capture

### Wave 5  (13 stories)

- [E1-S2](https://github.com/zdemanche/boxalarm-backend/issues/44) — Exactly-once alert fan-out to push and SMS in parallel
- [E2-S10](https://github.com/zdemanche/boxalarm-backend/issues/67) — Shift give-back and swap with officer approval
- [E2-S4](https://github.com/zdemanche/boxalarm-backend/issues/61) — Configurable LOSAP point rules and running totals
- [E2-S9](https://github.com/zdemanche/boxalarm-backend/issues/66) — Shift coverage visibility
- [E3-S2](https://github.com/zdemanche/boxalarm-backend/issues/70) — Configurable-lead-time expiry scanner for certifications
- [E3-S5](https://github.com/zdemanche/boxalarm-backend/issues/73) — Training hours tracked by member, category, and period
- [E3-S8](https://github.com/zdemanche/boxalarm-backend/issues/76) — Expired certification revokes qual currency and propagates to alerting eligibility
- [E4-S3](https://github.com/zdemanche/boxalarm-backend/issues/79) — Complete a glove-friendly truck check in under 90 seconds, offline-capable
- [E5-S4](https://github.com/zdemanche/boxalarm-backend/issues/94) — Publish inspections.preplan.updated and inspections.hydrant.updated to the alerting-plane copy
- [E5-S7](https://github.com/zdemanche/boxalarm-backend/issues/97) — Mobile field capture with photos, offline-tolerant
- [E6-S3](https://github.com/zdemanche/boxalarm-backend/issues/101) — Guided incident completion with pre-submission NERIS enumeration validation
- [E6-S6](https://github.com/zdemanche/boxalarm-backend/issues/104) — Exposure and responder-safety capture (NERIS Secondary schema)
- [E7-S7](https://github.com/zdemanche/boxalarm-backend/issues/116) — Membership and attendance trend reporting

### Wave 6  (15 stories)

- [E1-S11](https://github.com/zdemanche/boxalarm-backend/issues/52) — Channel failure-domain isolation and no-SPOF chaos verification
- [E1-S13](https://github.com/zdemanche/boxalarm-backend/issues/54) — Notification service isolation regression test and IAM enforcement
- [E1-S17](https://github.com/zdemanche/boxalarm-backend/issues/57) — Pre-plan and hydrant enrichment on the alert detail screen
- [E1-S3](https://github.com/zdemanche/boxalarm-backend/issues/45) — Voice escalation on no-ack at T+75s
- [E1-S4](https://github.com/zdemanche/boxalarm-backend/issues/46) — Per-member delivery receipts and provider webhook ingestion
- [E1-S5](https://github.com/zdemanche/boxalarm-backend/issues/47) — Response confirmation with ETA and live response roster
- [E1-S6](https://github.com/zdemanche/boxalarm-backend/issues/48) — Core alert content: type, address, cross streets, map link, narrative
- [E1-S7](https://github.com/zdemanche/boxalarm-ui/issues/26) — iOS Critical Alerts and Android full-screen intent DND override
- [E2-S11](https://github.com/zdemanche/boxalarm-backend/issues/68) — Shift attendance feeds LOSAP and reporting automatically
- [E3-S3](https://github.com/zdemanche/boxalarm-backend/issues/71) — Digest-batched cert expiry notifications to member and training officer
- [E3-S6](https://github.com/zdemanche/boxalarm-backend/issues/74) — ISO-aligned training hour reporting
- [E3-S7](https://github.com/zdemanche/boxalarm-backend/issues/75) — Exportable per-member training transcript
- [E4-S10](https://github.com/zdemanche/boxalarm-backend/issues/86) — Check-compliance reporting — what got checked, what didn't
- [E7-S3](https://github.com/zdemanche/boxalarm-backend/issues/112) — LOSAP year-end report
- [E7-S5](https://github.com/zdemanche/boxalarm-backend/issues/114) — Grant-support (AFG/SAFER-style) report

### Wave 7  (9 stories)

- [E1-S8](https://github.com/zdemanche/boxalarm-backend/issues/49) — Member self-test of their own alert path
- [E1-S9](https://github.com/zdemanche/boxalarm-backend/issues/50) — Alert delivery audit log
- [E4-S12](https://github.com/zdemanche/boxalarm-backend/issues/88) — PPE assignment with sizes and NFPA service-life expiry alerting
- [E4-S13](https://github.com/zdemanche/boxalarm-backend/issues/89) — Consumable stock levels and reorder-threshold alerting
- [E4-S4](https://github.com/zdemanche/boxalarm-backend/issues/80) — Report a defect with photo, routed to the apparatus officer
- [E4-S7](https://github.com/zdemanche/boxalarm-backend/issues/83) — SCBA unit, cylinder, flow-test, and hydro-test records
- [E4-S8](https://github.com/zdemanche/boxalarm-backend/issues/84) — Hose, ladder, pump, and aerial testing schedules with due-alerting
- [E5-S8](https://github.com/zdemanche/boxalarm-backend/issues/98) — Pre-plan and hydrant panel inside an active alert
- [E6-S2](https://github.com/zdemanche/boxalarm-backend/issues/100) — Create incident pre-populated from alert, CAD, and response roster

### Wave 8  (4 stories)

- [E1-S10](https://github.com/zdemanche/boxalarm-backend/issues/51) — Continuous production canary with on-call escalation
- [E1-S12](https://github.com/zdemanche/boxalarm-backend/issues/53) — 'Why didn't I get the page' self-diagnosis tool
- [E1-S15](https://github.com/zdemanche/boxalarm-backend/issues/56) — Parallel tone-out run, delivery baseline, and cutover decision gate (N1.9)
- [E6-S5](https://github.com/zdemanche/boxalarm-backend/issues/103) — Apparatus and personnel response times with unit assignment

### Wave 9  (2 stories)

- [E6-S8](https://github.com/zdemanche/boxalarm-backend/issues/106) — NERIS submission with exponential backoff and outbox-pattern reliability
- [E7-S6](https://github.com/zdemanche/boxalarm-backend/issues/115) — Response-time analytics (turnout, travel, total)

### Wave 10  (1 stories)

- [E6-S9](https://github.com/zdemanche/boxalarm-backend/issues/107) — Visible, retriable submission status — never a silent drop

### Wave 11  (1 stories)

- [E7-S2](https://github.com/zdemanche/boxalarm-backend/issues/111) — Reporting rollup projections from domain events

### Wave 12  (2 stories)

- [E7-S1](https://github.com/zdemanche/boxalarm-backend/issues/110) — Chief operational dashboard
- [E7-S4](https://github.com/zdemanche/boxalarm-backend/issues/113) — ISO reporting support

### Wave 13  (2 stories)

- [E7-S8](https://github.com/zdemanche/boxalarm-ui/issues/27) — Reporting UI for dashboard and named reports
- [E7-S9](https://github.com/zdemanche/boxalarm-backend/issues/117) — CSV/PDF export for all reports

## Release framing

The wave order is topological. For delivery, sequence by these gates instead:

| Gate | Contains | Why |
|---|---|---|
| **Start immediately** | E1-S16 (CAD resolution), E6-S12 (NERIS vendor account), OQ-2, OQ-4 | External lead times. None is engineering work; all can block a later wave if started late. |
| **Foundation** | Waves 1–3 — auth, roles, observability, residency assertions, domain roots | Nothing user-facing ships, but everything else sits on it. |
| **Chief360 parity — alerting** | E1 through E1-S9, plus E2 roster and shifts | This is the increment that replaces Chief360's primary function and the point at which the department gets real value. |
| **Compliance** | E6 NERIS submission, E4 apparatus checks | The federal obligation and the highest-frequency daily workflow. |
| **Everything else** | E3, E5, E7, remaining E4/E8 | Valuable, not urgent. |

**The N1.9 cutover gate (E1-S15) is not a wave item.** Retiring radio tone-out is a measured decision made after live delivery data justifies it — see the SPOF table in `architecture.md`.
