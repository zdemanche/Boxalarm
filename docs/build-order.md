# Boxalarm — Build Order

8 epics · 90 stories · 13 dependency waves · 160 edges · no cycles

> **A wave is a feasibility bound, not a shippable release.** Each story sits at the earliest
> point its dependencies allow. Priority ordering is layered on top — see *Release framing* below.

## Epics

- [**E1**](https://github.com/zdemanche/Boxalarm-monorepo/issues/1) — A volunteer never misses the call for duty
- [**E2**](https://github.com/zdemanche/Boxalarm-monorepo/issues/14) — The roster always reflects who can respond, with what, and when
- [**E3**](https://github.com/zdemanche/Boxalarm-monorepo/issues/15) — No one's certification lapses without warning
- [**E4**](https://github.com/zdemanche/Boxalarm-monorepo/issues/16) — Apparatus, PPE, and equipment are always known to be in-service or not
- [**E5**](https://github.com/zdemanche/Boxalarm-monorepo/issues/17) — The pre-plan and the hydrant are one tap away when it matters
- [**E6**](https://github.com/zdemanche/Boxalarm-monorepo/issues/18) — The incident report writes most of itself and clears NERIS the first time
- [**E7**](https://github.com/zdemanche/Boxalarm-monorepo/issues/20) — Compliance and grant reports come out of the system instead of into a spreadsheet
- [**E8**](https://github.com/zdemanche/Boxalarm-monorepo/issues/21) — The department can run, secure, and own its own platform without a vendor on call

## Waves

### Wave 1  (8 stories)

- [E1-S16](https://github.com/zdemanche/Boxalarm-monorepo/issues/13) — Resolve CAD integration surface and obtain dispatch-authority authorization
- [E6-S12](https://github.com/zdemanche/Boxalarm-monorepo/issues/19) — NERIS Integration Partner vendor onboarding and compatibility check
- [E6-S7](https://github.com/zdemanche/Boxalarm-monorepo/issues/89) — NERIS environment configuration and OAuth2 client-credentials integration
- [E8-S1](https://github.com/zdemanche/Boxalarm-monorepo/issues/101) — Cross-platform sign-in, no MFA
- [E8-S11](https://github.com/zdemanche/Boxalarm-monorepo/issues/110) — Platform-wide observability foundation: structured logging, tracing, metrics (N8.1)
- [E8-S5](https://github.com/zdemanche/Boxalarm-monorepo/issues/105) — Tamper-evident audit log for every record mutation
- [E8-S7](https://github.com/zdemanche/Boxalarm-monorepo/issues/107) — Department-scoping tenancy seam across the data model
- [E8-S9](https://github.com/zdemanche/Boxalarm-monorepo/issues/109) — Records retention configuration and verified disposal

### Wave 2  (3 stories)

- [E8-S10](https://github.com/zdemanche/Boxalarm-monorepo/issues/179) — Assert U.S.-only data residency and encryption posture in CI (N6.1, N5.1)
- [E8-S3](https://github.com/zdemanche/Boxalarm-monorepo/issues/103) — Role-based authorization via Verified Permissions (Cedar)
- [E8-S8](https://github.com/zdemanche/Boxalarm-monorepo/issues/108) — Session policy and token revocation

### Wave 3  (11 stories)

- [E1-S1](https://github.com/zdemanche/Boxalarm-monorepo/issues/27) — Manual dispatch entry adapter (degraded-mode fallback)
- [E2-S1](https://github.com/zdemanche/Boxalarm-monorepo/issues/42) — Member roster CRUD with status lifecycle
- [E2-S7](https://github.com/zdemanche/Boxalarm-monorepo/issues/48) — Duty shift definition with required positions and quals
- [E4-S1](https://github.com/zdemanche/Boxalarm-monorepo/issues/61) — Apparatus registry with in/out-of-service status
- [E4-S11](https://github.com/zdemanche/Boxalarm-monorepo/issues/71) — Equipment/asset registry with serial numbers, assignment, and location
- [E5-S1](https://github.com/zdemanche/Boxalarm-monorepo/issues/75) — Occupancy records: create, view, edit
- [E5-S3](https://github.com/zdemanche/Boxalarm-monorepo/issues/77) — Hydrant registry: location, size, flow, last test, out-of-service
- [E6-S1](https://github.com/zdemanche/Boxalarm-monorepo/issues/83) — NERIS-native incident data model with opaque versioned payloads
- [E8-S2](https://github.com/zdemanche/Boxalarm-monorepo/issues/102) — Self-service, reliable credential recovery
- [E8-S4](https://github.com/zdemanche/Boxalarm-monorepo/issues/104) — Department configuration management
- [E8-S6](https://github.com/zdemanche/Boxalarm-monorepo/issues/106) — Full department data export

### Wave 4  (19 stories)

- [E1-S14](https://github.com/zdemanche/Boxalarm-monorepo/issues/39) — Register and rotate device push tokens
- [E2-S2](https://github.com/zdemanche/Boxalarm-monorepo/issues/43) — Qualifications and quals-based eligibility
- [E2-S3](https://github.com/zdemanche/Boxalarm-monorepo/issues/44) — Attendance capture across calls, drills, meetings, work details, and standby
- [E2-S5](https://github.com/zdemanche/Boxalarm-monorepo/issues/46) — Planned unavailability (marking off) that suppresses alerting
- [E2-S6](https://github.com/zdemanche/Boxalarm-monorepo/issues/47) — Member self-service profile and contact update
- [E2-S8](https://github.com/zdemanche/Boxalarm-monorepo/issues/49) — Atomic open-shift signup with offline-pending claim handling
- [E3-S1](https://github.com/zdemanche/Boxalarm-monorepo/issues/53) — Certification records with issuing authority and attachments
- [E3-S4](https://github.com/zdemanche/Boxalarm-monorepo/issues/56) — Drill and training event scheduling with member sign-up
- [E4-S14](https://github.com/zdemanche/Boxalarm-monorepo/issues/74) — Asset lifecycle: acquisition through retirement
- [E4-S2](https://github.com/zdemanche/Boxalarm-monorepo/issues/62) — Configurable per-apparatus check-sheet templates
- [E4-S5](https://github.com/zdemanche/Boxalarm-monorepo/issues/65) — Out-of-service tracking with reason, duration, and availability impact
- [E4-S6](https://github.com/zdemanche/Boxalarm-monorepo/issues/66) — Maintenance history and scheduled maintenance
- [E4-S9](https://github.com/zdemanche/Boxalarm-monorepo/issues/69) — Compartment inventory per apparatus
- [E5-S2](https://github.com/zdemanche/Boxalarm-monorepo/issues/76) — Pre-incident plans with attachments, site diagrams, and utility shutoffs
- [E5-S5](https://github.com/zdemanche/Boxalarm-monorepo/issues/79) — Inspection scheduling, conduct, and violation tracking
- [E5-S6](https://github.com/zdemanche/Boxalarm-monorepo/issues/80) — Map-based retrieval of occupancies and hydrants
- [E6-S10](https://github.com/zdemanche/Boxalarm-monorepo/issues/92) — Incident search and history
- [E6-S11](https://github.com/zdemanche/Boxalarm-monorepo/issues/93) — Schema-version independence — NERIS schema updates without a data-model redeploy
- [E6-S4](https://github.com/zdemanche/Boxalarm-monorepo/issues/86) — Incident narrative capture

### Wave 5  (13 stories)

- [E1-S2](https://github.com/zdemanche/Boxalarm-monorepo/issues/28) — Exactly-once alert fan-out to push and SMS in parallel
- [E2-S10](https://github.com/zdemanche/Boxalarm-monorepo/issues/51) — Shift give-back and swap with officer approval
- [E2-S4](https://github.com/zdemanche/Boxalarm-monorepo/issues/45) — Configurable LOSAP point rules and running totals
- [E2-S9](https://github.com/zdemanche/Boxalarm-monorepo/issues/50) — Shift coverage visibility
- [E3-S2](https://github.com/zdemanche/Boxalarm-monorepo/issues/54) — Configurable-lead-time expiry scanner for certifications
- [E3-S5](https://github.com/zdemanche/Boxalarm-monorepo/issues/57) — Training hours tracked by member, category, and period
- [E3-S8](https://github.com/zdemanche/Boxalarm-monorepo/issues/60) — Expired certification revokes qual currency and propagates to alerting eligibility
- [E4-S3](https://github.com/zdemanche/Boxalarm-monorepo/issues/63) — Complete a glove-friendly truck check in under 90 seconds, offline-capable
- [E5-S4](https://github.com/zdemanche/Boxalarm-monorepo/issues/78) — Publish inspections.preplan.updated and inspections.hydrant.updated to the alerting-plane copy
- [E5-S7](https://github.com/zdemanche/Boxalarm-monorepo/issues/81) — Mobile field capture with photos, offline-tolerant
- [E6-S3](https://github.com/zdemanche/Boxalarm-monorepo/issues/85) — Guided incident completion with pre-submission NERIS enumeration validation
- [E6-S6](https://github.com/zdemanche/Boxalarm-monorepo/issues/88) — Exposure and responder-safety capture (NERIS Secondary schema)
- [E7-S7](https://github.com/zdemanche/Boxalarm-monorepo/issues/262) — Membership and attendance trend reporting

### Wave 6  (15 stories)

- [E1-S11](https://github.com/zdemanche/Boxalarm-monorepo/issues/36) — Channel failure-domain isolation and no-SPOF chaos verification
- [E1-S13](https://github.com/zdemanche/Boxalarm-monorepo/issues/38) — Notification service isolation regression test and IAM enforcement
- [E1-S17](https://github.com/zdemanche/Boxalarm-monorepo/issues/41) — Pre-plan and hydrant enrichment on the alert detail screen
- [E1-S3](https://github.com/zdemanche/Boxalarm-monorepo/issues/29) — Voice escalation on no-ack at T+75s
- [E1-S4](https://github.com/zdemanche/Boxalarm-monorepo/issues/30) — Per-member delivery receipts and provider webhook ingestion
- [E1-S5](https://github.com/zdemanche/Boxalarm-monorepo/issues/31) — Response confirmation with ETA and live response roster
- [E1-S6](https://github.com/zdemanche/Boxalarm-monorepo/issues/32) — Core alert content: type, address, cross streets, map link, narrative
- [E1-S7](https://github.com/zdemanche/Boxalarm-monorepo/issues/116) — iOS Critical Alerts and Android full-screen intent DND override
- [E2-S11](https://github.com/zdemanche/Boxalarm-monorepo/issues/52) — Shift attendance feeds LOSAP and reporting automatically
- [E3-S3](https://github.com/zdemanche/Boxalarm-monorepo/issues/55) — Digest-batched cert expiry notifications to member and training officer
- [E3-S6](https://github.com/zdemanche/Boxalarm-monorepo/issues/58) — ISO-aligned training hour reporting
- [E3-S7](https://github.com/zdemanche/Boxalarm-monorepo/issues/59) — Exportable per-member training transcript
- [E4-S10](https://github.com/zdemanche/Boxalarm-monorepo/issues/70) — Check-compliance reporting — what got checked, what didn't
- [E7-S3](https://github.com/zdemanche/Boxalarm-monorepo/issues/96) — LOSAP year-end report
- [E7-S5](https://github.com/zdemanche/Boxalarm-monorepo/issues/98) — Grant-support (AFG/SAFER-style) report

### Wave 7  (9 stories)

- [E1-S8](https://github.com/zdemanche/Boxalarm-monorepo/issues/33) — Member self-test of their own alert path
- [E1-S9](https://github.com/zdemanche/Boxalarm-monorepo/issues/34) — Alert delivery audit log
- [E4-S12](https://github.com/zdemanche/Boxalarm-monorepo/issues/72) — PPE assignment with sizes and NFPA service-life expiry alerting
- [E4-S13](https://github.com/zdemanche/Boxalarm-monorepo/issues/73) — Consumable stock levels and reorder-threshold alerting
- [E4-S4](https://github.com/zdemanche/Boxalarm-monorepo/issues/64) — Report a defect with photo, routed to the apparatus officer
- [E4-S7](https://github.com/zdemanche/Boxalarm-monorepo/issues/67) — SCBA unit, cylinder, flow-test, and hydro-test records
- [E4-S8](https://github.com/zdemanche/Boxalarm-monorepo/issues/68) — Hose, ladder, pump, and aerial testing schedules with due-alerting
- [E5-S8](https://github.com/zdemanche/Boxalarm-monorepo/issues/82) — Pre-plan and hydrant panel inside an active alert
- [E6-S2](https://github.com/zdemanche/Boxalarm-monorepo/issues/84) — Create incident pre-populated from alert, CAD, and response roster

### Wave 8  (4 stories)

- [E1-S10](https://github.com/zdemanche/Boxalarm-monorepo/issues/35) — Continuous production canary with on-call escalation
- [E1-S12](https://github.com/zdemanche/Boxalarm-monorepo/issues/37) — 'Why didn't I get the page' self-diagnosis tool
- [E1-S15](https://github.com/zdemanche/Boxalarm-monorepo/issues/40) — Parallel tone-out run, delivery baseline, and cutover decision gate (N1.9)
- [E6-S5](https://github.com/zdemanche/Boxalarm-monorepo/issues/87) — Apparatus and personnel response times with unit assignment

### Wave 9  (2 stories)

- [E6-S8](https://github.com/zdemanche/Boxalarm-monorepo/issues/90) — NERIS submission with exponential backoff and outbox-pattern reliability
- [E7-S6](https://github.com/zdemanche/Boxalarm-monorepo/issues/99) — Response-time analytics (turnout, travel, total)

### Wave 10  (1 stories)

- [E6-S9](https://github.com/zdemanche/Boxalarm-monorepo/issues/91) — Visible, retriable submission status — never a silent drop

### Wave 11  (1 stories)

- [E7-S2](https://github.com/zdemanche/Boxalarm-monorepo/issues/95) — Reporting rollup projections from domain events

### Wave 12  (2 stories)

- [E7-S1](https://github.com/zdemanche/Boxalarm-monorepo/issues/94) — Chief operational dashboard
- [E7-S4](https://github.com/zdemanche/Boxalarm-monorepo/issues/97) — ISO reporting support

### Wave 13  (2 stories)

- [E7-S8](https://github.com/zdemanche/Boxalarm-monorepo/issues/117) — Reporting UI for dashboard and named reports
- [E7-S9](https://github.com/zdemanche/Boxalarm-monorepo/issues/100) — CSV/PDF export for all reports

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
