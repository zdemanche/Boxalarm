# Product Requirements Document — Fire Department Operations Platform

**Version:** 0.1 (draft for review)
**Date:** 2026-09-03
**Tenant zero:** Nichols Fire Department, Trumbull, CT 06615
**Status:** Draft — open questions in §12 must be resolved before architecture is locked

---

## 1. Summary

A single platform covering everything a fire department does between alarms and after them: alerting members to a call, tracking who responded, recording what happened, keeping apparatus and equipment in service, keeping certifications current, and filing federally-required incident data.

The department currently runs Chief360. This replaces it.

The bet is not "more features." Incumbents already have feature lists. The bet is that **the two things that actually matter — alerting that never misses, and incident reporting that isn't miserable — are both done badly by the current market**, and that a platform built NERIS-native in 2026, after the NFIRS retirement, has a structural advantage over incumbents retrofitting a legacy schema.

---

## 2. Background and market context

### 2.1 What Chief360 is, and where it hurts

Chief360 is primarily a **response and alerting platform** — mobile response notification, tone alerting, station alerting, riding boards, scheduling, dashboards, and an apparatus MDT.

Its publicly documented user complaints are concentrated in exactly the wrong place:

- Intermittent notification delivery after an app update
- Duplicate message storms (a single dispatch generating multiple alerts)
- Login failures not resolved by reinstall
- Escalations reported as unresolved

For a career department with staffed apparatus, a flaky alert app is an annoyance. **For a volunteer department it is a total product failure** — the alert *is* the staffing mechanism. If a volunteer doesn't get toned out, the apparatus doesn't roll.

This drives requirement **F1** and non-functional requirement **N1**, both P0.

### 2.2 The NERIS transition

NFIRS was retired **January 31, 2026**. As of February 2026 it is unavailable to all users, and no CY2026 incidents are accepted. NERIS — the National Emergency Response Information System, built by FSRI/UL Research Institutes with USFA — is now the **only** national fire incident data system.

This matters commercially: every incumbent RMS is carrying a NFIRS-shaped data model and mapping it forward. A platform whose incident model *is* the NERIS entity model has no impedance mismatch, no lossy mapping, and no legacy migration debt.

NERIS integration surface (confirmed):

| Aspect | Detail |
|---|---|
| Auth | OAuth 2.0 — Authorization Code or Client Credentials |
| API | FastAPI, Swagger at `api.neris.fsri.org/v1/docs` |
| Schemas | Core + Secondary, XLSX/YAML/CSV, `github.com/ulfsri/neris-framework` |
| Clients | Official Python client (PyPI `neris-api-client`), community NodeJS client |
| Incident ID | department ID + dispatch number + epoch seconds |
| Lifecycle | Submitted → validated → augmented with weather/census |
| Rate limits | WAF-enforced; HTTP 429, exponential backoff required |
| Headers | Unique `User-Agent` **mandatory** — missing = HTTP 403 |
| Data residency | **Servers must operate within U.S. geographic boundaries** |
| Environments | Separate dev environment; **never test against production** |
| Vendor path | Integration Partner Program → Client ID/Secret → compatibility check via helpdesk |

**Architecture-binding constraints:** U.S.-only region pinning, a dedicated NERIS-dev integration environment, and a named `User-Agent` per environment.

### 2.3 Competitive landscape

Emergency Reporting, Alpine RedAlert, Resgrid, FireOps1, Responserack, Fire Station Software, Station Boss, First Due, ImageTrend, ESO. The volunteer-department segment is served, but the tools are largely desktop-era products with mobile bolted on, and LOSAP/ISO reporting is consistently the advertised differentiator — which tells us it is consistently painful.

---

## 3. Users

| Persona | Context | Primary needs |
|---|---|---|
| **Firefighter / volunteer member** | Phone, often mid-task, sometimes driving, sometimes in turnout gear with gloves | Get the tone. Say "responding." See what and where. Log a truck check in 90 seconds. |
| **Officer / lieutenant / captain** | Scene or station | Who's coming and with what quals. Riding assignments. Write the incident report. |
| **Chief** | Office and phone | Staffing reality, ISO readiness, cert expirations, apparatus out of service, NERIS compliance |
| **Training officer** | Office | Cert expiry, drill attendance, training hours, state/ISO reporting |
| **Apparatus / equipment officer** | Apparatus floor, on a phone | Check compliance, defects, SCBA and testing schedules, what's out of service |
| **Administrator / secretary** | Office | Membership, LOSAP points, attendance, municipal and grant reporting |

**Design center: a volunteer on a phone, at night, in a hurry.** Any workflow that assumes a desk is wrong by default.

---

## 4. Goals

1. **No missed alerts.** Alert delivery is engineered, instrumented, and provably reliable — not assumed.
2. **NERIS-native incident reporting.** Compliant submission without a mapping layer, and without the report feeling like a tax form.
3. **Replace Chief360 entirely** — no residual dependency, no parallel systems.
4. **Mobile-first, offline-tolerant.** Fire scenes and apparatus bays have bad connectivity.
5. **Reporting that writes itself.** LOSAP, ISO, and municipal reports generated from operational data already captured, not re-keyed.
6. **Deployable to a second department** without a rewrite.

### 4.1 Non-goals (v1)

- **EMS / ePCR / patient care reporting.** Fire-only department. No PHI, no HIPAA, no BAA, no NEMSIS. *This is the single largest scope boundary in the document — do not erode it without an explicit decision.*
- **NFIRS support.** The system is retired. No legacy import target.
- **CAD replacement.** We integrate with dispatch; we do not become dispatch.
- **Fire station physical control** (bay doors, traffic signals, appliance control). Chief360 does this; it is a hardware integration program of its own.
- **Payroll or municipal finance.** We produce reports that feed them.
- **Public-facing portal.**

---

## 5. Functional requirements

Priority: **P0** = required to replace Chief360 · **P1** = required for a complete product · **P2** = fast-follow

### F1. Alerting and response — *P0, the flagship*

- **F1.1** Receive dispatch from CAD and/or paging input; normalize into an incident alert
- **F1.2** Push alert to all eligible members: push notification, with SMS and voice fallback
- **F1.3** **Delivery receipts** — per-member sent/delivered/opened, visible to officers in real time
- **F1.4** **Escalation ladder** — no acknowledgement within N seconds escalates to the next channel
- **F1.5** **Idempotent alert dispatch** — one dispatch produces exactly one alert per member. Duplicate storms are a defect class, not a tuning issue.
- **F1.6** Response confirmation: responding / not responding / responding direct to scene, with ETA
- **F1.7** Live response roster — who is coming, quals held, ETA, assigned apparatus
- **F1.8** Alert content: incident type, address, cross streets, map link, dispatch narrative, hydrant and pre-plan links
- **F1.9** Critical-alert delivery that overrides device silent/DND where the platform allows
- **F1.10** **Self-test** — members and admins can verify their own alert path end to end, on demand, without a real call
- **F1.11** Alert delivery audit log, retained and queryable — the evidence base for "did it work"

### F2. Personnel and membership — *P0*

- **F2.1** Member roster: contact, status (active/probationary/LOA/retired), join date, rank, agency ID
- **F2.2** Qualifications and quals-based eligibility (interior, driver/operator, officer, etc.)
- **F2.3** Attendance capture for calls, drills, meetings, work details, standby
- **F2.4** **LOSAP points** — configurable point rules per activity, running totals, year-end reports, per-member visibility
- **F2.5** Availability / marking off — planned unavailability affecting alerting
- **F2.6** Member self-service profile and contact update
- **F2.7** Roles and permissions (member / officer / training / apparatus / admin / chief)

### F3. Training and certifications — *P0*

- **F3.1** Certification records with issue and expiry dates, issuing authority, attachments
- **F3.2** **Expiry alerting** — configurable lead time, to member and training officer
- **F3.3** Drill and training event scheduling, sign-up, attendance
- **F3.4** Training hours by member, category, and period
- **F3.5** ISO-aligned training hour reporting
- **F3.6** Per-member training transcript, exportable
- **F3.7** Link quals (F2.2) to certification currency — an expired cert affects eligibility

### F4. Apparatus and equipment — *P0*

- **F4.1** Apparatus registry: unit ID, type, status, in/out of service
- **F4.2** **Mobile check sheets** — per-apparatus configurable checklists, completable on a phone at the rig, glove-friendly
- **F4.3** Defect reporting from a check, with photo, routed to the apparatus officer
- **F4.4** Out-of-service tracking with reason, duration, and impact on availability
- **F4.5** Maintenance history and scheduled maintenance
- **F4.6** **SCBA** records: unit, cylinder, flow test, hydro dates
- **F4.7** Testing schedules with due alerting: hose, ladder, pump, aerial
- **F4.8** Compartment inventory per apparatus
- **F4.9** Check compliance reporting — what got checked, what didn't, by whom

### F5. Inventory and supplies — *P1*

- **F5.1** Equipment registry with serial/asset numbers, assignment, location
- **F5.2** PPE assignment per member, with sizes and **expiry** (NFPA service life)
- **F5.3** Consumable stock levels and reorder thresholds
- **F5.4** Asset lifecycle: acquisition, service, retirement

### F6. Inspections and pre-incident planning — *P1*

- **F6.1** Occupancy records: address, occupancy type, contacts, hazards
- **F6.2** **Pre-incident plans** with attachments, site diagrams, utility shutoffs, hazards — **retrievable from within an active alert (F1.8)**
- **F6.3** Inspection scheduling, conduct, and violation tracking
- **F6.4** **Hydrant records**: location, size, flow, last flow test, out-of-service
- **F6.5** Mobile field capture with photos
- **F6.6** Map-based retrieval

### F7. Incident reporting (NERIS) — *P0*

- **F7.1** Incident model native to the NERIS Core schema — no NFIRS-shaped intermediate
- **F7.2** Pre-population from the alert, CAD, and the response roster — the report starts mostly written
- **F7.3** Guided completion with validation against NERIS enumerations *before* submission
- **F7.4** Narrative capture
- **F7.5** Apparatus and personnel response times and unit assignment
- **F7.6** **NERIS submission via API** with OAuth 2.0, exponential backoff on 429, and a named `User-Agent`
- **F7.7** Submission status tracking and error surfacing; failed submissions are visible and retriable, never silently dropped
- **F7.8** Exposure and responder-safety capture (Secondary schema)
- **F7.9** Incident search and history
- **F7.10** Schema-version awareness — NERIS schemas will change; version changes must not require redeploying the data model

### F8. Reporting and analytics — *P1*

- **F8.1** Chief dashboard: staffing, response performance, OOS apparatus, expiring certs, NERIS compliance
- **F8.2** LOSAP year-end reporting
- **F8.3** ISO reporting support (training hours, apparatus testing, hydrants, response)
- **F8.4** Grant-support reporting (AFG/SAFER-style)
- **F8.5** Response-time analytics: turnout, travel, total
- **F8.6** Membership and attendance trends
- **F8.7** CSV/PDF export

### F9. Platform and administration — *P0*

- **F9.1** Authentication with MFA available; **credential recovery must be self-service and reliable** (a documented Chief360 failure)
- **F9.2** Role-based authorization
- **F9.3** Department configuration: apparatus, stations, ranks, point rules, checklists, alert rules
- **F9.4** Audit logging for all record mutation
- **F9.5** Data export — no lock-in; the department owns its data
- **F9.6** **Tenancy seams** — single-tenant in operation, but department scoping present in the data model from day one

---

## 6. Non-functional requirements

### N1. Alert reliability — *the defining NFR*

- **N1.1** Alert fan-out initiated within **5 seconds** of dispatch receipt (p99)
- **N1.2** Redundant delivery channels; no single-vendor dependency for the critical path
- **N1.3** Delivery instrumented end to end and **alertable on failure** — the system must notice its own failure
- **N1.4** Exactly-once semantics per member per dispatch
- **N1.5** Alerting path degrades independently — an outage in reporting, training, or inventory must never impair alerting
- **N1.6** Synthetic end-to-end alert canary running continuously in production

### N2. Availability

- **N2.1** Alerting path target **99.9%+**; explicitly higher than the rest of the platform
- **N2.2** No scheduled maintenance window that takes alerting down

### N3. Mobile and offline

- **N3.1** Every field workflow (checks, inspections, attendance, response) completable on a phone
- **N3.2** Offline capture with sync-on-reconnect for checks and field data
- **N3.3** Touch targets usable with gloves
- **N3.4** Night-legible display for in-apparatus use

### N4. Performance

- **N4.1** Interactive screens < 2s on cellular
- **N4.2** Truck check completable in < 90 seconds

### N5. Security

- **N5.1** Encryption in transit and at rest
- **N5.2** MFA available; enforceable for privileged roles
- **N5.3** Least-privilege authorization, enforced server-side
- **N5.4** Secrets never in source; OAuth credentials rotatable
- **N5.5** Member PII minimized and access-audited
- **N5.6** No PHI in v1 — enforced by scope, not by policy alone

### N6. Compliance and data residency

- **N6.1** **All servers and data within U.S. geographic boundaries** (NERIS requirement)
- **N6.2** NERIS Integration Partner compatibility check passed before production submission
- **N6.3** Records retention configurable to CT and municipal requirements
- **N6.4** Never test against NERIS production

### N7. Accessibility

- **N7.1** WCAG 2.1 AA
- **N7.2** Screen-reader support on all primary workflows
- **N7.3** Contrast usable in daylight and in a dark apparatus cab

### N8. Operability

- **N8.1** Structured logging, tracing, metrics
- **N8.2** Alerting on the alerting path is P0 operational tooling
- **N8.3** A department admin can diagnose "why didn't I get the page" without vendor support

---

## 7. Key integrations

| System | Direction | Priority | Notes |
|---|---|---|---|
| **NERIS** | Outbound + reference | P0 | OAuth2, rate-limited, U.S.-only, dev env mandatory |
| **CAD / dispatch** | Inbound | P0 | Mechanism TBD — see §12. Determines F1.1. |
| **Push notification** | Outbound | P0 | APNs / FCM, critical-alert entitlement |
| **SMS / voice** | Outbound | P0 | Fallback channel; must be a separate failure domain from push |
| **Mapping** | Outbound | P1 | Address → map, routing |
| **State of Connecticut reporting** | Outbound | TBD | See §12 |

---

## 8. Constraints

- **Budget:** volunteer municipal department. Run cost must be small and predominantly usage-based. This is a hard constraint, not a preference.
- **Deployment:** AWS serverless — Cognito, API Gateway/Lambda, DynamoDB single-table, Pulumi IaC. U.S. region pinned.
- **No micro-frontend topology.** One application. The Moonaan MFE shell/remote pattern is deliberately excluded as unjustified at this scale.
- **Support model:** no 24/7 staffed support. The system must be self-diagnosing and self-recovering.
- **Adoption:** volunteers are unpaid. A workflow harder than the current one will simply not be used.

---

## 9. Success metrics

| Metric | Target |
|---|---|
| Alert delivery rate | > 99.9% of eligible members per dispatch |
| Alert fan-out latency | < 5s p99 from dispatch receipt |
| Duplicate alerts | 0 |
| Truck check completion time | < 90 seconds median |
| Apparatus check compliance | > 95% of scheduled checks completed |
| NERIS submission success | 100%, no silent failures |
| Incident report completion time | 50% below Chief360 baseline |
| Certification lapse incidents | 0 unexpected lapses |
| Chief360 decommissioned | Complete, no parallel running |

---

## 10. Proposed build order

Full scope is committed. This is sequencing, not scope reduction — dependency waves, to be confirmed by `dependency-sequencer`.

| Wave | Contents | Rationale |
|---|---|---|
| **1** | F9 platform/auth, F2 personnel, F1 alerting | Alerting is the flagship and needs identity + roster beneath it. Delivers standalone value immediately. |
| **2** | F7 NERIS incident reporting, F4 apparatus | The compliance obligation and the highest-frequency daily workflow |
| **3** | F3 training/certs, F8 reporting | Feeds on attendance data captured in waves 1–2 |
| **4** | F6 inspections/pre-plans, F5 inventory | Pre-plans become more valuable once alerting exists to surface them |

Wave 1 alone replaces Chief360's primary function.

---

## 11. Assumptions

1. **Nichols FD is a volunteer department.** Personnel is modeled as volunteer roster, response availability, and LOSAP points — *not* career shift scheduling with overtime and minimum staffing. **⚠ Confirm before architecture — this is the highest-impact assumption in the document.**
2. Fire-only. No EMS transport, no patient care records.
3. Single department at launch; multi-tenancy is a seam, not a feature.
4. Members have smartphones capable of running a modern app.
5. The department can obtain a NERIS Integration Partner vendor account.
6. Existing Chief360 data may need migration — scope unknown.

---

## 12. Open questions

**Blocking architecture:**

1. **Volunteer, career, or combination?** (Assumption 1.) Changes the entire personnel and scheduling model.
2. **How does dispatch reach the department today?** Regional/municipal CAD vendor, active 911 dispatch center, existing integration or paging? **This determines F1.1 and is the single largest unknown in the alerting design.**
3. **Radio/tone paging interaction** — does the platform supplement existing tone-out paging, or replace it? Are physical pagers staying?

**Blocking backlog:**

4. Connecticut state fire reporting requirements beyond NERIS?
5. CT LOSAP statutory point rules — what exactly must be tracked?
6. Chief360 data migration — what must come across, and can it be exported?
7. Mutual aid — Trumbull has multiple volunteer companies. Cross-department visibility in scope?
8. Native apps or PWA? (Critical-alert entitlement and DND override may force native.)
9. Station alerting hardware — is any in place that must be driven or preserved?

**Commercial:**

10. Who owns the software, and is a second department a real near-term target?

---

## 13. What "better than Chief360" means concretely

1. **Alerts that provably arrive** — receipts, escalation, self-test, canary, and a duplicate rate of zero
2. **NERIS-native, not NFIRS-retrofitted**
3. **A truck check that takes 90 seconds on a phone**
4. **Reports that generate themselves** from data already captured
5. **Self-diagnosable** — a member can prove their own alert path works
6. **No lock-in** — the department can export everything it owns
