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
- [E6-S7](https://github.com/zdemanche/boxalarm-docs/issues/84) — NERIS environment configuration and OAuth2 client-credentials integration
- [E8-S1](https://github.com/zdemanche/boxalarm-docs/issues/101) — Cross-platform sign-in with MFA
- [E8-S11](https://github.com/zdemanche/boxalarm-docs/issues/111) — Platform-wide observability foundation: structured logging, tracing, metrics (N8.1)
- [E8-S5](https://github.com/zdemanche/boxalarm-docs/issues/105) — Tamper-evident audit log for every record mutation
- [E8-S7](https://github.com/zdemanche/boxalarm-docs/issues/107) — Department-scoping tenancy seam across the data model
- [E8-S9](https://github.com/zdemanche/boxalarm-docs/issues/109) — Records retention configuration and verified disposal

### Wave 2  (3 stories)

- [E8-S10](https://github.com/zdemanche/boxalarm-docs/issues/110) — Assert U.S.-only data residency and encryption posture in CI (N6.1, N5.1)
- [E8-S3](https://github.com/zdemanche/boxalarm-docs/issues/103) — Role-based authorization via Verified Permissions (Cedar)
- [E8-S8](https://github.com/zdemanche/boxalarm-docs/issues/108) — Session policy and step-up re-authentication enforcement

### Wave 3  (11 stories)

- [E1-S1](https://github.com/zdemanche/boxalarm-docs/issues/15) — Manual dispatch entry adapter (degraded-mode fallback)
- [E2-S1](https://github.com/zdemanche/boxalarm-docs/issues/33) — Member roster CRUD with status lifecycle
- [E2-S7](https://github.com/zdemanche/boxalarm-docs/issues/39) — Duty shift definition with required positions and quals
- [E4-S1](https://github.com/zdemanche/boxalarm-docs/issues/54) — Apparatus registry with in/out-of-service status
- [E4-S11](https://github.com/zdemanche/boxalarm-docs/issues/64) — Equipment/asset registry with serial numbers, assignment, and location
- [E5-S1](https://github.com/zdemanche/boxalarm-docs/issues/69) — Occupancy records: create, view, edit
- [E5-S3](https://github.com/zdemanche/boxalarm-docs/issues/71) — Hydrant registry: location, size, flow, last test, out-of-service
- [E6-S1](https://github.com/zdemanche/boxalarm-docs/issues/78) — NERIS-native incident data model with opaque versioned payloads
- [E8-S2](https://github.com/zdemanche/boxalarm-docs/issues/102) — Self-service, reliable credential recovery
- [E8-S4](https://github.com/zdemanche/boxalarm-docs/issues/104) — Department configuration management
- [E8-S6](https://github.com/zdemanche/boxalarm-docs/issues/106) — Full department data export with step-up authentication

### Wave 4  (19 stories)

- [E1-S14](https://github.com/zdemanche/boxalarm-docs/issues/28) — Register and rotate device push tokens
- [E2-S2](https://github.com/zdemanche/boxalarm-docs/issues/34) — Qualifications and quals-based eligibility
- [E2-S3](https://github.com/zdemanche/boxalarm-docs/issues/35) — Attendance capture across calls, drills, meetings, work details, and standby
- [E2-S5](https://github.com/zdemanche/boxalarm-docs/issues/37) — Planned unavailability (marking off) that suppresses alerting
- [E2-S6](https://github.com/zdemanche/boxalarm-docs/issues/38) — Member self-service profile and contact update
- [E2-S8](https://github.com/zdemanche/boxalarm-docs/issues/40) — Atomic open-shift signup with offline-pending claim handling
- [E3-S1](https://github.com/zdemanche/boxalarm-docs/issues/45) — Certification records with issuing authority and attachments
- [E3-S4](https://github.com/zdemanche/boxalarm-docs/issues/48) — Drill and training event scheduling with member sign-up
- [E4-S14](https://github.com/zdemanche/boxalarm-docs/issues/67) — Asset lifecycle: acquisition through retirement
- [E4-S2](https://github.com/zdemanche/boxalarm-docs/issues/55) — Configurable per-apparatus check-sheet templates
- [E4-S5](https://github.com/zdemanche/boxalarm-docs/issues/58) — Out-of-service tracking with reason, duration, and availability impact
- [E4-S6](https://github.com/zdemanche/boxalarm-docs/issues/59) — Maintenance history and scheduled maintenance
- [E4-S9](https://github.com/zdemanche/boxalarm-docs/issues/62) — Compartment inventory per apparatus
- [E5-S2](https://github.com/zdemanche/boxalarm-docs/issues/70) — Pre-incident plans with attachments, site diagrams, and utility shutoffs
- [E5-S5](https://github.com/zdemanche/boxalarm-docs/issues/73) — Inspection scheduling, conduct, and violation tracking
- [E5-S6](https://github.com/zdemanche/boxalarm-docs/issues/74) — Map-based retrieval of occupancies and hydrants
- [E6-S10](https://github.com/zdemanche/boxalarm-docs/issues/87) — Incident search and history
- [E6-S11](https://github.com/zdemanche/boxalarm-docs/issues/88) — Schema-version independence — NERIS schema updates without a data-model redeploy
- [E6-S4](https://github.com/zdemanche/boxalarm-docs/issues/81) — Incident narrative capture

### Wave 5  (13 stories)

- [E1-S2](https://github.com/zdemanche/boxalarm-docs/issues/16) — Exactly-once alert fan-out to push and SMS in parallel
- [E2-S10](https://github.com/zdemanche/boxalarm-docs/issues/42) — Shift give-back and swap with officer approval
- [E2-S4](https://github.com/zdemanche/boxalarm-docs/issues/36) — Configurable LOSAP point rules and running totals
- [E2-S9](https://github.com/zdemanche/boxalarm-docs/issues/41) — Shift coverage visibility
- [E3-S2](https://github.com/zdemanche/boxalarm-docs/issues/46) — Configurable-lead-time expiry scanner for certifications
- [E3-S5](https://github.com/zdemanche/boxalarm-docs/issues/49) — Training hours tracked by member, category, and period
- [E3-S8](https://github.com/zdemanche/boxalarm-docs/issues/52) — Expired certification revokes qual currency and propagates to alerting eligibility
- [E4-S3](https://github.com/zdemanche/boxalarm-docs/issues/56) — Complete a glove-friendly truck check in under 90 seconds, offline-capable
- [E5-S4](https://github.com/zdemanche/boxalarm-docs/issues/72) — Publish inspections.preplan.updated and inspections.hydrant.updated to the alerting-plane copy
- [E5-S7](https://github.com/zdemanche/boxalarm-docs/issues/75) — Mobile field capture with photos, offline-tolerant
- [E6-S3](https://github.com/zdemanche/boxalarm-docs/issues/80) — Guided incident completion with pre-submission NERIS enumeration validation
- [E6-S6](https://github.com/zdemanche/boxalarm-docs/issues/83) — Exposure and responder-safety capture (NERIS Secondary schema)
- [E7-S7](https://github.com/zdemanche/boxalarm-docs/issues/97) — Membership and attendance trend reporting

### Wave 6  (15 stories)

- [E1-S11](https://github.com/zdemanche/boxalarm-docs/issues/25) — Channel failure-domain isolation and no-SPOF chaos verification
- [E1-S13](https://github.com/zdemanche/boxalarm-docs/issues/27) — Notification service isolation regression test and IAM enforcement
- [E1-S17](https://github.com/zdemanche/boxalarm-docs/issues/31) — Pre-plan and hydrant enrichment on the alert detail screen
- [E1-S3](https://github.com/zdemanche/boxalarm-docs/issues/17) — Voice escalation on no-ack at T+75s
- [E1-S4](https://github.com/zdemanche/boxalarm-docs/issues/18) — Per-member delivery receipts and provider webhook ingestion
- [E1-S5](https://github.com/zdemanche/boxalarm-docs/issues/19) — Response confirmation with ETA and live response roster
- [E1-S6](https://github.com/zdemanche/boxalarm-docs/issues/20) — Core alert content: type, address, cross streets, map link, narrative
- [E1-S7](https://github.com/zdemanche/boxalarm-docs/issues/21) — iOS Critical Alerts and Android full-screen intent DND override
- [E2-S11](https://github.com/zdemanche/boxalarm-docs/issues/43) — Shift attendance feeds LOSAP and reporting automatically
- [E3-S3](https://github.com/zdemanche/boxalarm-docs/issues/47) — Digest-batched cert expiry notifications to member and training officer
- [E3-S6](https://github.com/zdemanche/boxalarm-docs/issues/50) — ISO-aligned training hour reporting
- [E3-S7](https://github.com/zdemanche/boxalarm-docs/issues/51) — Exportable per-member training transcript
- [E4-S10](https://github.com/zdemanche/boxalarm-docs/issues/63) — Check-compliance reporting — what got checked, what didn't
- [E7-S3](https://github.com/zdemanche/boxalarm-docs/issues/93) — LOSAP year-end report
- [E7-S5](https://github.com/zdemanche/boxalarm-docs/issues/95) — Grant-support (AFG/SAFER-style) report

### Wave 7  (9 stories)

- [E1-S8](https://github.com/zdemanche/boxalarm-docs/issues/22) — Member self-test of their own alert path
- [E1-S9](https://github.com/zdemanche/boxalarm-docs/issues/23) — Alert delivery audit log
- [E4-S12](https://github.com/zdemanche/boxalarm-docs/issues/65) — PPE assignment with sizes and NFPA service-life expiry alerting
- [E4-S13](https://github.com/zdemanche/boxalarm-docs/issues/66) — Consumable stock levels and reorder-threshold alerting
- [E4-S4](https://github.com/zdemanche/boxalarm-docs/issues/57) — Report a defect with photo, routed to the apparatus officer
- [E4-S7](https://github.com/zdemanche/boxalarm-docs/issues/60) — SCBA unit, cylinder, flow-test, and hydro-test records
- [E4-S8](https://github.com/zdemanche/boxalarm-docs/issues/61) — Hose, ladder, pump, and aerial testing schedules with due-alerting
- [E5-S8](https://github.com/zdemanche/boxalarm-docs/issues/76) — Pre-plan and hydrant panel inside an active alert
- [E6-S2](https://github.com/zdemanche/boxalarm-docs/issues/79) — Create incident pre-populated from alert, CAD, and response roster

### Wave 8  (4 stories)

- [E1-S10](https://github.com/zdemanche/boxalarm-docs/issues/24) — Continuous production canary with on-call escalation
- [E1-S12](https://github.com/zdemanche/boxalarm-docs/issues/26) — 'Why didn't I get the page' self-diagnosis tool
- [E1-S15](https://github.com/zdemanche/boxalarm-docs/issues/29) — Parallel tone-out run, delivery baseline, and cutover decision gate (N1.9)
- [E6-S5](https://github.com/zdemanche/boxalarm-docs/issues/82) — Apparatus and personnel response times with unit assignment

### Wave 9  (2 stories)

- [E6-S8](https://github.com/zdemanche/boxalarm-docs/issues/85) — NERIS submission with exponential backoff and outbox-pattern reliability
- [E7-S6](https://github.com/zdemanche/boxalarm-docs/issues/96) — Response-time analytics (turnout, travel, total)

### Wave 10  (1 stories)

- [E6-S9](https://github.com/zdemanche/boxalarm-docs/issues/86) — Visible, retriable submission status — never a silent drop

### Wave 11  (1 stories)

- [E7-S2](https://github.com/zdemanche/boxalarm-docs/issues/92) — Reporting rollup projections from domain events

### Wave 12  (2 stories)

- [E7-S1](https://github.com/zdemanche/boxalarm-docs/issues/91) — Chief operational dashboard
- [E7-S4](https://github.com/zdemanche/boxalarm-docs/issues/94) — ISO reporting support

### Wave 13  (2 stories)

- [E7-S8](https://github.com/zdemanche/boxalarm-docs/issues/98) — Reporting UI for dashboard and named reports
- [E7-S9](https://github.com/zdemanche/boxalarm-docs/issues/99) — CSV/PDF export for all reports

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
