# Boxalarm — Product Requirements Document

**Version:** 0.2
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
- **F2.8** **Duty shifts** — officers define shifts/standby periods with required positions and quals
- **F2.9** **Open-shift signup** — members browse and claim open shifts from mobile; claiming is atomic (no double-booking)
- **F2.10** Shift coverage view — which shifts are covered, which are short, which lack a required qual
- **F2.11** Shift give-back / swap between members, with officer approval where configured
- **F2.12** Shift attendance feeds LOSAP points (F2.4) and reporting (F8) automatically

> **Note:** this is *volunteer* scheduling — self-service signup for open duty shifts. It is explicitly **not** career shift scheduling: no overtime, no callback lists, no Kelly days, no minimum-staffing mandates. Coverage gaps are surfaced, not enforced.

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

- **F9.1** Authentication — **no MFA anywhere, and a session that does not expire: sign in once and forget.** A responder woken at 03:00 opens the app and sees the call, never a login screen and never a second factor; a re-authentication prompt on the alert path is an alerting failure (N1), not a security feature. Sessions are long-lived by design with silent background token refresh, no idle timeout, and no periodic forced re-authentication. **Credential recovery must be self-service and reliable** (a documented Chief360 failure). **No step-up re-authentication either** — not on data export (F9.5), not on destructive admin actions, not anywhere: a password re-entry prompt is friction the platform does not impose. Sensitive admin surfaces are protected by **role-based authorization alone** (F9.2), evaluated server-side on a valid session. ⚠ **The security cost is real and accepted, not mitigated:** one password is the whole authentication system for every role, a valid chief/admin session is by itself enough to export the department's entire dataset, and the controls left on those actions detect and reverse rather than prevent (per-invocation alarm to the chief, audit event, token revocation). See N5.2.
- **F9.2** Role-based authorization
- **F9.3** Department configuration: apparatus, stations, ranks, point rules, checklists, alert rules
- **F9.4** Audit logging for all record mutation
- **F9.5** Data export — no lock-in; the department owns its data
- **F9.6** **Tenancy seams** — single-tenant in operation, but department scoping present in the data model from day one

---

## 6. Non-functional requirements

### N1. Alert reliability — *life-safety critical*

> **The app replaces radio tone-out paging as the alerting path of record.** A delivery failure means no response to an emergency call. This is life-safety software, and N1 is engineered accordingly — it is not a quality target, it is the product's reason to exist.

- **N1.1** Alert fan-out initiated within **5 seconds** of dispatch receipt (p99)
- **N1.2** Redundant delivery channels in **independent failure domains** — push, SMS, and voice must not share a vendor, network path, or availability zone
- **N1.3** Delivery instrumented end to end and **alertable on failure** — the system must notice its own failure and escalate to a human
- **N1.4** Exactly-once semantics per member per dispatch
- **N1.5** Alerting path degrades independently — an outage in reporting, training, inventory, or *any* other module must never impair alerting. Architecturally isolated.
- **N1.6** Synthetic end-to-end alert canary running continuously in production, alerting on-call within minutes of a broken path
- **N1.7** **No single point of failure** anywhere between dispatch ingress and member device
- **N1.8** **Documented degraded mode** — defined behavior and human fallback procedure when the platform is unavailable
- **N1.9** **Parallel-run requirement:** existing tone-out paging is retained alongside the platform until measured delivery data over a full cycle of live use justifies cutover. App-only is the destination, not the launch state.

### N2. Availability

- **N2.1** Alerting path target **99.95%+**; explicitly and substantially higher than the rest of the platform
- **N2.2** No scheduled maintenance window that takes alerting down — ever
- **N2.3** Alerting must survive a single AWS AZ failure without degradation

### N3. Mobile and offline

- **N3.1** **Native iOS and Android applications.** Required, not preferred: critical-alert entitlement and reliable Do-Not-Disturb override are unavailable to a PWA, and N1 cannot be met without them.
- **N3.2** iOS Critical Alerts entitlement obtained from Apple; Android full-screen intent / high-priority notification channels configured
- **N3.3** Every field workflow (checks, inspections, attendance, response, shift signup) completable on a phone
- **N3.4** Offline capture with sync-on-reconnect for checks and field data
- **N3.5** Touch targets usable with gloves
- **N3.6** Night-legible display for in-apparatus use
- **N3.7** Alert receipt must not depend on the app being foregrounded, recently opened, or exempt from OS battery optimization

### N4. Performance

- **N4.1** Interactive screens < 2s on cellular
- **N4.2** Truck check completable in < 90 seconds

### N5. Security

- **N5.1** Encryption in transit and at rest
- **N5.2** **No MFA, and no session expiry a responder can hit** — long-lived refresh tokens (near the identity provider's maximum) held in Keychain/Keystore on native and secure storage on web, refreshed silently; no idle timeout, no forced re-authentication. This is a deliberate trade of account-security depth for alerting reliability (F9.1, N1), taken with eyes open: **token revocation on member status change, not token expiry, is the control that ends a session** — and revocation needs a human to notice, which the support model (§8) does not staff. Privileged actions (export, disposal) are gated by role authorization only, with per-invocation alarming as the detective control
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

1. **Nichols FD is all-volunteer, with member-claimable duty shifts.** *(Confirmed 2026-09-03.)* Personnel is a volunteer roster with LOSAP points and self-service open-shift signup — not career scheduling.
2. **The app replaces tone-out paging as the alerting path of record.** *(Confirmed 2026-09-03.)* Drives the life-safety classification of N1, with a parallel-run period per N1.9.
3. **Native iOS + Android.** *(Confirmed 2026-09-03.)* Required for critical-alert delivery.
4. Fire-only. No EMS transport, no patient care records.
5. Single department at launch; multi-tenancy is a seam, not a feature.
6. Members have smartphones capable of running a modern app. **⚠ Members without a capable smartphone cannot be alerted — a real coverage gap given N1.9 cutover, and one the department must consciously accept.**
7. The department can obtain a NERIS Integration Partner vendor account.
8. Existing Chief360 data may need migration — scope unknown.

---

## 12. Open questions

**Blocking architecture — OUTSTANDING:**

1. **CAD integration surface.** Dispatch comes from a **regional CAD system** *(confirmed 2026-09-03)* — so a digital feed exists and alert ingress does not require tone-decoder hardware. Still needed before the ingress adapter can be built:
   - **a. Which regional CAD?** Vendor and product (Motorola, Tyler/New World, CentralSquare, Hexagon, Mark43, ProPhoenix, IMC…). Determines whether an API, CAD-to-CAD interface, or only a relay exists.
   - **b. How does Chief360 receive dispatch today?** *This is the highest-value question* — whatever feed already reaches the department is the path most likely reusable, and it proves the integration is permitted.
   - **c. What is the delivery mechanism?** API/webhook · CAD-to-CAD · email relay · SMS relay · paging protocol (TAP/IXP) · third-party middleware (Active911, IamResponding, PulsePoint).
   - **d. Who authorizes the integration?** Regional dispatch authority approval is typically required and is a lead-time item, not a technical one.

   Ingress is designed as a port with pluggable adapters (F1.1), so the architecture is not blocked — but the concrete adapter cannot be implemented until a–c are answered, and **d may be the long pole on the whole project**.

**Resolved 2026-09-03:** staffing model (all-volunteer + pickup shifts, F2.8–F2.12) · paging interaction (replace, with N1.9 parallel run) · native vs PWA (native, N3.1) · dispatch source is a regional CAD, i.e. a digital feed exists.

**Blocking backlog:**

2. Connecticut state fire reporting requirements beyond NERIS?
3. CT LOSAP statutory point rules — what exactly must be tracked?
4. Chief360 data migration — what must come across, and can it be exported?
5. Mutual aid — Trumbull has multiple volunteer companies. Cross-department visibility in scope?
6. Station alerting hardware — is any in place that must be driven or preserved?
7. Apple Critical Alerts entitlement — requires justification to Apple; who owns that application?

**Commercial:**

8. Who owns the software, and is a second department a real near-term target?

---

## 13. What "better than Chief360" means concretely

1. **Alerts that provably arrive** — receipts, escalation, self-test, canary, and a duplicate rate of zero
2. **NERIS-native, not NFIRS-retrofitted**
3. **A truck check that takes 90 seconds on a phone**
4. **Reports that generate themselves** from data already captured
5. **Self-diagnosable** — a member can prove their own alert path works
6. **No lock-in** — the department can export everything it owns
