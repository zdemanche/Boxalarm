import type { ProblemDetails } from '../../lib/apiClient';
import { DEMO_FLEET } from '../../lib/demoRoster';
import type {
  Apparatus,
  ApparatusDetail,
  ChecklistTemplate,
  ComplianceEntry,
  CompartmentGroup,
  CreateApparatusInput,
  MaintenanceRecord,
  OpenDefectSummary,
  ScbaDueEntry,
  ScbaRecord,
  TestingScheduleEntry,
} from './types';

/*
 * Nichols FD tenant-zero apparatus registry for the demo build. The fleet comes from the shared
 * roster module so the riding board, incidents and reports all name the same seven units. Every
 * date is relative to module load (no fixed calendar dates, no randomness), so the compliance
 * report, due-soon panels and test schedules read the same way whenever the demo is opened.
 */

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;
const daysAgo = (days: number): number => NOW - days * DAY;
const daysAhead = (days: number): number => NOW + days * DAY;
const isoDaysFromNow = (days: number): string =>
  new Date((NOW + days * DAY) * 1000).toISOString().slice(0, 10);

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function problem(status: number, title: string): Response {
  const body: ProblemDetails = { type: 'about:blank', title, status, traceId: 'demo' };
  return json(body, status);
}

// ---------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------

/** Truck 304 went down two days ago; the alerting riding board carries the same reason. */
const TRUCK_304_OOS_START = daysAgo(2);

let apparatus: Apparatus[] = DEMO_FLEET.map((unit): Apparatus =>
  unit.unitId === 'Truck 304'
    ? {
        apparatusId: unit.apparatusId,
        unitId: unit.unitId,
        type: unit.type,
        status: 'OUT_OF_SERVICE',
        outOfService: {
          reason: 'Aerial hydraulic leak',
          startAt: TRUCK_304_OOS_START,
          // Recomputed live from startAt on every read below (withLiveElapsed), same as the real
          // API — this seed value is just the value at module load.
          elapsedSeconds: NOW - TRUCK_304_OOS_START,
        },
      }
    : { apparatusId: unit.apparatusId, unitId: unit.unitId, type: unit.type, status: 'IN_SERVICE' },
);

function findByApparatusId(apparatusId: string): Apparatus | undefined {
  return apparatus.find((a) => a.apparatusId === apparatusId);
}

function findByUnitId(unitId: string): Apparatus | undefined {
  return apparatus.find((a) => a.unitId === unitId);
}

// Mirrors which identifier each real apparatus-service handler resolves its `{unitId}` path
// segment by: detail, checklist, service-status, SCBA and test-record writes look the unit up by
// its display unitId (GSI3); maintenance and inventory use the segment directly as the
// apparatusId partition key.
const SUB_RESOURCES_KEYED_BY_APPARATUS_ID = new Set(['maintenance', 'inventory']);

// Mirrors the real backend (repository.ts): elapsedSeconds is derived from startAt at read
// time, not stored, so it stays correct across a long-lived demo session.
function withLiveElapsed(unit: Apparatus): Apparatus {
  if (!unit.outOfService) return unit;
  return {
    ...unit,
    outOfService: {
      ...unit.outOfService,
      elapsedSeconds: Math.max(0, Math.floor(Date.now() / 1000) - unit.outOfService.startAt),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Checklist templates — one per apparatus class, as the truck check on the phone walks them
// ---------------------------------------------------------------------------------------------

function unitIdsOfType(...types: string[]): string[] {
  return DEMO_FLEET.filter((unit) => types.includes(unit.type)).map((unit) => unit.apparatusId);
}

const CHECKLIST_TEMPLATES: readonly ChecklistTemplate[] = [
  {
    templateId: 'CT-ENGINE',
    name: 'Engine daily check',
    applicableApparatusIds: unitIdsOfType('Engine'),
    items: [
      { code: 'FUEL', label: 'Fuel above 3/4', requiresPhoto: false, critical: true },
      {
        code: 'WATER',
        label: 'Tank full, tank-to-pump open',
        requiresPhoto: false,
        critical: true,
      },
      { code: 'TIRES', label: 'Tires and wheels', requiresPhoto: false },
      { code: 'FLUIDS', label: 'Fluid levels', requiresPhoto: false },
      { code: 'LIGHTS', label: 'Lights and sirens', requiresPhoto: false },
      { code: 'PUMP', label: 'Pump engages, primer works', requiresPhoto: false, critical: true },
      { code: 'HOSE', label: 'Hose loads and nozzles in place', requiresPhoto: false },
      { code: 'SCBA', label: 'SCBA seated and cylinders above 90%', requiresPhoto: true },
      { code: 'RADIO', label: 'Mobile and portable radios', requiresPhoto: false },
      { code: 'MDT', label: 'MDT signed in and mapping', requiresPhoto: false },
    ],
  },
  {
    templateId: 'CT-LADDER',
    name: 'Aerial daily check',
    applicableApparatusIds: unitIdsOfType('Ladder'),
    items: [
      { code: 'FUEL', label: 'Fuel above 3/4', requiresPhoto: false, critical: true },
      { code: 'TIRES', label: 'Tires and wheels', requiresPhoto: false },
      { code: 'FLUIDS', label: 'Fluid levels', requiresPhoto: false },
      { code: 'LIGHTS', label: 'Lights and sirens', requiresPhoto: false },
      {
        code: 'AERIAL',
        label: 'Aerial hydraulics — no leaks, PTO engages',
        requiresPhoto: false,
        critical: true,
      },
      { code: 'OUTRIGGERS', label: 'Outriggers and pads', requiresPhoto: false },
      { code: 'GROUND_LADDERS', label: 'Ground ladder complement', requiresPhoto: false },
      { code: 'SAWS', label: 'Saws start, blades and fuel', requiresPhoto: false },
      { code: 'SCBA', label: 'SCBA seated and cylinders above 90%', requiresPhoto: true },
      { code: 'RADIO', label: 'Mobile and portable radios', requiresPhoto: false },
    ],
  },
  {
    templateId: 'CT-RESCUE',
    name: 'Rescue / squad daily check',
    applicableApparatusIds: unitIdsOfType('Rescue', 'Squad'),
    items: [
      { code: 'FUEL', label: 'Fuel above 3/4', requiresPhoto: false, critical: true },
      { code: 'TIRES', label: 'Tires and wheels', requiresPhoto: false },
      { code: 'FLUIDS', label: 'Fluid levels', requiresPhoto: false },
      { code: 'LIGHTS', label: 'Lights, sirens and scene lighting', requiresPhoto: false },
      { code: 'GENERATOR', label: 'Generator starts and takes load', requiresPhoto: false },
      {
        code: 'EXTRICATION',
        label: 'Hydraulic tools — power unit runs, hoses intact',
        requiresPhoto: false,
        critical: true,
      },
      { code: 'CRIBBING', label: 'Cribbing and struts', requiresPhoto: false },
      { code: 'SCBA', label: 'SCBA seated and cylinders above 90%', requiresPhoto: true },
      { code: 'MEDICAL', label: 'Trauma bag, AED and oxygen', requiresPhoto: false },
      { code: 'RADIO', label: 'Mobile and portable radios', requiresPhoto: false },
    ],
  },
  {
    templateId: 'CT-LIGHT',
    name: 'Utility / brush weekly check',
    applicableApparatusIds: unitIdsOfType('Utility', 'Brush'),
    items: [
      { code: 'FUEL', label: 'Fuel above 3/4', requiresPhoto: false, critical: true },
      { code: 'TIRES', label: 'Tires and wheels', requiresPhoto: false },
      { code: 'FLUIDS', label: 'Fluid levels', requiresPhoto: false },
      { code: 'LIGHTS', label: 'Lights and sirens', requiresPhoto: false },
      { code: 'SKID', label: 'Skid unit pump starts, tank full', requiresPhoto: false },
      { code: 'TOOLS', label: 'Hand tools and backpack pumps', requiresPhoto: false },
      { code: 'RADIO', label: 'Mobile radio', requiresPhoto: false },
    ],
  },
];

function templateFor(unit: Apparatus): ChecklistTemplate {
  return (
    CHECKLIST_TEMPLATES.find((t) => t.applicableApparatusIds.includes(unit.apparatusId)) ??
    // A unit created during the demo session: checked like a light-duty vehicle.
    CHECKLIST_TEMPLATES[CHECKLIST_TEMPLATES.length - 1]!
  );
}

// ---------------------------------------------------------------------------------------------
// Check history (last 30 days) and compliance
// ---------------------------------------------------------------------------------------------

interface CheckRecord {
  apparatusId: string;
  templateId: string;
  completedAt: number;
  completedBy: string;
}

const WEEKLY_TYPES = new Set(['Utility', 'Brush']);
const CHECK_HISTORY_DAYS = 30;

/** Who did the morning check that day — rotates through the engineers and the duty officer. */
const CHECKERS = ['m-12', 'm-13', 'm-14', 'm-9', 'm-21', 'm-23'] as const;

/**
 * Which days a unit's check was skipped, so the compliance report has something to say.
 * Engine 305 misses every fifth day, Rescue 300 every eleventh, Squad 309 every ninth;
 * Engine 301 is never missed. Truck 304 is not checked while out of service.
 */
function missedDailyCheck(apparatusId: string, dayIndex: number): boolean {
  if (apparatusId === 'a-4') return dayIndex % 5 === 1;
  if (apparatusId === 'a-1') return dayIndex % 11 === 4;
  if (apparatusId === 'a-5') return dayIndex % 9 === 3;
  return false;
}

/** Day offset (0 = today) of each weekly check: Utility 302 two days ago, Brush 307 nine days
 * ago — the brush truck's weekly check is a week late. */
function weeklyCheckDays(apparatusId: string): number[] {
  const anchor = apparatusId === 'a-6' ? 2 : 9;
  return [anchor, anchor + 7, anchor + 14, anchor + 21].filter((d) => d < CHECK_HISTORY_DAYS);
}

function buildCheckHistory(): CheckRecord[] {
  const history: CheckRecord[] = [];
  for (const unit of apparatus) {
    const templateId = templateFor(unit).templateId;
    const days = WEEKLY_TYPES.has(unit.type)
      ? weeklyCheckDays(unit.apparatusId)
      : Array.from({ length: CHECK_HISTORY_DAYS }, (_, d) => d).filter(
          (d) => !missedDailyCheck(unit.apparatusId, d),
        );
    for (const d of days) {
      // Each check lands two hours before "now" on its day, so none is in the future.
      const completedAt = daysAgo(d) - 2 * 3600;
      // Nobody checks a unit that is out of service.
      if (unit.outOfService && completedAt >= unit.outOfService.startAt) continue;
      history.push({
        apparatusId: unit.apparatusId,
        templateId,
        completedAt,
        completedBy: CHECKERS[(d + Number(unit.apparatusId.slice(2))) % CHECKERS.length]!,
      });
    }
  }
  return history;
}

const checkHistory: CheckRecord[] = buildCheckHistory();

/**
 * The compliance report for the window the page opens with (the last seven days). The demo
 * router strips the query string before this handler sees it, so the from/to the page sends
 * cannot be honoured — the figures are always for the trailing week.
 */
const COMPLIANCE_WINDOW_DAYS = 7;

function complianceReport(): ComplianceEntry[] {
  const from = daysAgo(COMPLIANCE_WINDOW_DAYS);
  return apparatus.map((unit) => {
    const weekly = WEEKLY_TYPES.has(unit.type);
    let expectedChecks = weekly ? 1 : COMPLIANCE_WINDOW_DAYS;
    if (!weekly && unit.outOfService) {
      // Days the unit has been out of service inside the window are not expected.
      const oosDays = Math.min(
        COMPLIANCE_WINDOW_DAYS,
        Math.ceil((NOW - Math.max(unit.outOfService.startAt, from)) / DAY),
      );
      expectedChecks = Math.max(0, COMPLIANCE_WINDOW_DAYS - oosDays);
    }
    const actualChecks = checkHistory.filter(
      (c) => c.apparatusId === unit.apparatusId && c.completedAt >= from,
    ).length;
    return {
      unitId: unit.unitId,
      expectedChecks,
      actualChecks,
      compliant: actualChecks >= expectedChecks,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Defects
// ---------------------------------------------------------------------------------------------

const ENGINE_301_TIRE_PHOTO = '/demo/engine-301-tire.svg';

interface DemoDefect extends OpenDefectSummary {
  apparatusId: string;
  itemCode: string | null;
  status: 'OPEN' | 'RESOLVED';
  resolvedAt: number | null;
}

const defects: DemoDefect[] = [
  {
    apparatusId: 'a-2',
    defectId: 'DEF-301-TIRE',
    description: 'Low tire pressure, rear axle',
    severity: 'MAJOR',
    reportedAt: NOW - 2 * 3600,
    photoS3Key: 'NICHOLS/defect/DEF-301-TIRE/tire.jpg',
    photoUrl: ENGINE_301_TIRE_PHOTO,
    itemCode: 'TIRES',
    status: 'OPEN',
    resolvedAt: null,
  },
  {
    apparatusId: 'a-4',
    defectId: 'DEF-305-LIGHT',
    description: 'Rear scene light, driver side, inoperative',
    severity: 'MINOR',
    reportedAt: daysAgo(12),
    photoS3Key: null,
    itemCode: 'LIGHTS',
    status: 'RESOLVED',
    resolvedAt: daysAgo(9),
  },
  {
    apparatusId: 'a-1',
    defectId: 'DEF-300-DOOR',
    description: 'Compartment R2 roll-up door sticks half open',
    severity: 'MINOR',
    reportedAt: daysAgo(24),
    photoS3Key: 'NICHOLS/defect/DEF-300-DOOR/door.jpg',
    itemCode: null,
    status: 'RESOLVED',
    resolvedAt: daysAgo(20),
  },
];

function openDefectsFor(apparatusId: string): OpenDefectSummary[] {
  return defects
    .filter((d) => d.apparatusId === apparatusId && d.status === 'OPEN')
    .map((d) => ({
      defectId: d.defectId,
      description: d.description,
      severity: d.severity,
      reportedAt: d.reportedAt,
      photoS3Key: d.photoS3Key,
      ...(d.photoUrl !== undefined ? { photoUrl: d.photoUrl } : {}),
    }));
}

function toDetail(unit: Apparatus): ApparatusDetail {
  return {
    ...withLiveElapsed(unit),
    openDefects: openDefectsFor(unit.apparatusId),
    failedTests: [],
  };
}

// ---------------------------------------------------------------------------------------------
// Maintenance, SCBA, testing, inventory
// ---------------------------------------------------------------------------------------------

type MaintenanceSeed = [
  description: string,
  vendor: string,
  cost: number,
  performedDaysAgo: number,
  nextDueInDays: number | null,
];

const MAINTENANCE_SEEDS: Record<string, MaintenanceSeed[]> = {
  'a-1': [
    ['Oil change and chassis lube', 'Trumbull Truck Service', 310, 95, 270],
    ['Generator service — Onan 10 kW', 'Trumbull Truck Service', 240, 180, 185],
    ['DOT inspection', 'CT DMV commercial inspection lane', 150, 240, 125],
  ],
  'a-2': [
    ['Annual pump service', 'Nichols Fire Apparatus', 850, 60, 14],
    ['Oil change', 'Trumbull Truck Service', 290, 120, 245],
    ['DOT inspection', 'CT DMV commercial inspection lane', 150, 200, 165],
    ['Brake pads and rotors, rear axle', 'Trumbull Truck Service', 1180, 300, null],
  ],
  'a-3': [
    ['Aerial hydraulic line replacement — parts on order', 'Pierce Northeast service', 0, 1, 5],
    ['Oil change', 'Trumbull Truck Service', 340, 140, 225],
    ['Annual aerial inspection and test', 'Mid-Atlantic Aerial Testing', 2400, 300, 65],
  ],
  'a-4': [
    ['Oil change', 'Trumbull Truck Service', 290, 30, 335],
    ['Annual pump service', 'Nichols Fire Apparatus', 850, 45, 320],
    ['DOT inspection', 'CT DMV commercial inspection lane', 150, 100, 265],
  ],
  'a-5': [
    ['Transmission service — returned to service', 'Trumbull Truck Service', 980, 3, null],
    ['DOT inspection', 'CT DMV commercial inspection lane', 150, 15, 350],
    ['Oil change', 'Trumbull Truck Service', 260, 75, 290],
  ],
  'a-6': [
    ['Oil change', 'Trumbull Truck Service', 180, 150, 215],
    ['Tires, four', 'Town Fair Tire', 1120, 400, null],
  ],
  'a-7': [
    ['Oil change', 'Trumbull Truck Service', 160, 210, 155],
    // Overdue: the skid-unit pump service was due last month.
    ['Skid unit pump service', 'Nichols Fire Apparatus', 420, 400, -35],
  ],
};

const maintenanceByUnit = new Map<string, MaintenanceRecord[]>(
  Object.entries(MAINTENANCE_SEEDS).map(([apparatusId, seeds]) => [
    apparatusId,
    seeds
      .map(([description, vendor, cost, performedDaysAgo, nextDueInDays]): MaintenanceRecord => ({
        apparatusId,
        performedAt: daysAgo(performedDaysAgo),
        description,
        vendor,
        cost,
        scheduledNextAt: nextDueInDays === null ? null : daysAhead(nextDueInDays),
      }))
      .sort((a, b) => b.performedAt - a.performedAt),
  ]),
);

function nextScheduled(records: readonly MaintenanceRecord[]): number | null {
  const due = records
    .map((r) => r.scheduledNextAt)
    .filter((at): at is number => at !== null)
    .sort((a, b) => a - b);
  return due[0] ?? null;
}

type ScbaSeed = [
  apparatusId: string,
  scbaUnitId: string,
  cylinderId: string,
  flowTestDaysAgo: number,
  hydroTestDaysAgo: number,
];

const FLOW_TEST_INTERVAL_DAYS = 365;
const HYDRO_TEST_INTERVAL_DAYS = 1825;

// Flow tests annually, hydros every five years. SCBA-305-3's flow test comes due in 12 days and
// SCBA-300-2's hydro in 40, so the due-soon list is not empty.
const SCBA_SEEDS: readonly ScbaSeed[] = [
  ['a-2', 'SCBA-301-1', 'CYL-4471', 118, 1210],
  ['a-2', 'SCBA-301-2', 'CYL-4472', 118, 1210],
  ['a-2', 'SCBA-301-3', 'CYL-4473', 118, 640],
  ['a-2', 'SCBA-301-4', 'CYL-4474', 118, 640],
  ['a-4', 'SCBA-305-1', 'CYL-4480', 201, 1480],
  ['a-4', 'SCBA-305-2', 'CYL-4481', 201, 1480],
  ['a-4', 'SCBA-305-3', 'CYL-4482', 353, 1480],
  ['a-4', 'SCBA-305-4', 'CYL-4483', 201, 390],
  ['a-1', 'SCBA-300-1', 'CYL-4490', 76, 900],
  ['a-1', 'SCBA-300-2', 'CYL-4491', 76, 1785],
  ['a-3', 'SCBA-304-1', 'CYL-4495', 160, 1100],
  ['a-3', 'SCBA-304-2', 'CYL-4496', 160, 1100],
  ['a-5', 'SCBA-309-1', 'CYL-4498', 42, 300],
  ['a-5', 'SCBA-309-2', 'CYL-4499', 42, 300],
];

const scbaByUnit = new Map<string, ScbaRecord[]>();
for (const [apparatusId, scbaUnitId, cylinderId, flowDaysAgo, hydroDaysAgo] of SCBA_SEEDS) {
  const flowTestDate = isoDaysFromNow(-flowDaysAgo);
  const hydroTestDate = isoDaysFromNow(-hydroDaysAgo);
  scbaByUnit.set(apparatusId, [
    ...(scbaByUnit.get(apparatusId) ?? []),
    {
      apparatusId,
      scbaUnitId,
      cylinderId,
      flowTestDate,
      hydroTestDate,
      nextFlowTestDue: addDays(flowTestDate, FLOW_TEST_INTERVAL_DAYS),
      nextHydroTestDue: addDays(hydroTestDate, HYDRO_TEST_INTERVAL_DAYS),
    },
  ]);
}

/** Default window when the request carries no withinDays (the query string is stripped). */
const SCBA_DUE_WINDOW_DAYS = 60;

function scbaDueSoon(): ScbaDueEntry[] {
  const horizon = isoDaysFromNow(SCBA_DUE_WINDOW_DAYS);
  const due: ScbaDueEntry[] = [];
  for (const records of scbaByUnit.values()) {
    for (const record of records) {
      if (record.nextFlowTestDue <= horizon) {
        due.push({
          apparatusId: record.apparatusId,
          scbaUnitId: record.scbaUnitId,
          cylinderId: record.cylinderId,
          testType: 'SCBA_FLOW',
          dueDate: record.nextFlowTestDue,
        });
      }
      if (record.nextHydroTestDue <= horizon) {
        due.push({
          apparatusId: record.apparatusId,
          scbaUnitId: record.scbaUnitId,
          cylinderId: record.cylinderId,
          testType: 'SCBA_HYDRO',
          dueDate: record.nextHydroTestDue,
        });
      }
    }
  }
  return due.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

// Annual tests: hose for the whole department on one date, pump and ladder per unit, the aerial
// alongside its ground ladders. Brush 307's pump test is already overdue.
const HOSE_TEST_DUE = isoDaysFromNow(120);
const testingSchedule: TestingScheduleEntry[] = [
  { unitId: 'Engine 301', testType: 'PUMP', nextDueDate: isoDaysFromNow(14) },
  { unitId: 'Engine 301', testType: 'HOSE', nextDueDate: HOSE_TEST_DUE },
  { unitId: 'Engine 301', testType: 'LADDER', nextDueDate: isoDaysFromNow(200) },
  { unitId: 'Engine 305', testType: 'PUMP', nextDueDate: isoDaysFromNow(320) },
  { unitId: 'Engine 305', testType: 'HOSE', nextDueDate: HOSE_TEST_DUE },
  { unitId: 'Engine 305', testType: 'LADDER', nextDueDate: isoDaysFromNow(200) },
  { unitId: 'Truck 304', testType: 'AERIAL', nextDueDate: isoDaysFromNow(65) },
  { unitId: 'Truck 304', testType: 'LADDER', nextDueDate: isoDaysFromNow(65) },
  { unitId: 'Truck 304', testType: 'HOSE', nextDueDate: HOSE_TEST_DUE },
  { unitId: 'Rescue 300', testType: 'LADDER', nextDueDate: isoDaysFromNow(200) },
  { unitId: 'Squad 309', testType: 'PUMP', nextDueDate: isoDaysFromNow(250) },
  { unitId: 'Squad 309', testType: 'HOSE', nextDueDate: HOSE_TEST_DUE },
  { unitId: 'Brush 307', testType: 'PUMP', nextDueDate: isoDaysFromNow(-35) },
  { unitId: 'Brush 307', testType: 'HOSE', nextDueDate: HOSE_TEST_DUE },
];

function compartment(
  apparatusId: string,
  compartmentCode: string,
  items: [name: string, quantity: number][],
): CompartmentGroup {
  return {
    compartmentCode,
    items: items.map(([itemName, quantity], index) => ({
      itemId: `inv-${apparatusId}-${compartmentCode}-${index + 1}`,
      itemName,
      quantity,
    })),
  };
}

const inventoryByUnit = new Map<string, CompartmentGroup[]>([
  [
    'a-2',
    [
      compartment('a-2', 'L1', [
        ['Halligan bar', 1],
        ['Flathead axe', 1],
        ['Thermal imaging camera', 1],
      ]),
      compartment('a-2', 'R2', [
        ['1¾" fog nozzle', 2],
        ['2½" smooth-bore nozzle', 1],
        ['Gated wye', 1],
      ]),
      compartment('a-2', 'REAR', [
        ['24 ft extension ladder', 1],
        ['14 ft roof ladder', 1],
        ['Hydrant bag with wrench', 1],
      ]),
    ],
  ],
  [
    'a-1',
    [
      compartment('a-1', 'L1', [
        ['Hydraulic spreader', 1],
        ['Hydraulic cutter', 1],
        ['Hydraulic ram', 1],
      ]),
      compartment('a-1', 'R1', [
        ['4x4 cribbing', 24],
        ['Step chocks', 4],
        ['Rescue struts', 2],
      ]),
    ],
  ],
]);

// ---------------------------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------------------------

export async function apparatusDemoRequest(
  path: string,
  method: string,
  body: Record<string, unknown>,
): Promise<Response | undefined> {
  const parts = path.split('/');
  if (parts[0] !== 'apparatus') return undefined;

  if (path === 'apparatus' && method === 'GET') {
    return json({ apparatus: apparatus.map(withLiveElapsed) });
  }

  if (path === 'apparatus' && method === 'POST') {
    const input = body as unknown as CreateApparatusInput;
    const created: Apparatus = {
      apparatusId: `a-${apparatus.length + 1}`,
      unitId: input.unitId,
      type: input.type,
      status: 'IN_SERVICE',
    };
    apparatus = [...apparatus, created];
    return json(created, 201);
  }

  if (path === 'apparatus/testing-schedules' && method === 'GET') {
    return json(testingSchedule);
  }

  if (path === 'apparatus/scba/testing-schedules' && method === 'GET') {
    return json({ dueSoon: scbaDueSoon() });
  }

  if (path.startsWith('apparatus/compliance') && method === 'GET') {
    return json({ report: complianceReport() });
  }

  // Before the 2-segment unit lookup: "defects" is a literal path, never a unitId.
  if (path.startsWith('apparatus/defects') && method === 'GET') {
    const open = apparatus.flatMap((unit) =>
      openDefectsFor(unit.apparatusId).map((defect) => ({
        ...defect,
        apparatusId: unit.apparatusId,
        unitId: unit.unitId,
        itemCode: defects.find((d) => d.defectId === defect.defectId)?.itemCode ?? null,
      })),
    );
    return json({ defects: open, truncated: false });
  }

  if (parts.length === 2 && method === 'GET') {
    const unit = findByUnitId(decodeURIComponent(parts[1] ?? ''));
    return unit ? json(toDetail(unit)) : problem(404, 'Apparatus not found');
  }

  const segment = decodeURIComponent(parts[1] ?? '');
  const unit = SUB_RESOURCES_KEYED_BY_APPARATUS_ID.has(parts[2] ?? '')
    ? findByApparatusId(segment)
    : findByUnitId(segment);
  if (!unit) return problem(404, 'Apparatus not found');
  const apparatusId = unit.apparatusId;

  if (parts[2] === 'defects' && parts[4] === 'resolve' && method === 'POST') {
    const defectId = decodeURIComponent(parts[3] ?? '');
    const defect = defects.find((d) => d.defectId === defectId && d.apparatusId === apparatusId);
    if (!defect) return problem(404, 'Defect not found');
    const resolvedAt = Math.floor(Date.now() / 1000);
    defect.status = 'RESOLVED';
    defect.resolvedAt = resolvedAt;
    return json({
      defectId,
      status: 'RESOLVED',
      resolvedAt,
      severity: defect.severity,
      unitStillOutOfService: unit.status === 'OUT_OF_SERVICE',
    });
  }

  if (parts[2] === 'checklist' && method === 'GET') {
    return json(templateFor(unit));
  }

  if (parts[2] === 'service-status' && method === 'PUT') {
    const status = body.status as Apparatus['status'];
    unit.status = status;
    unit.outOfService =
      status === 'OUT_OF_SERVICE'
        ? {
            reason: body.reason as string,
            startAt: Math.floor(Date.now() / 1000),
            elapsedSeconds: 0,
          }
        : undefined;
    return new Response(null, { status: 204 });
  }

  if (parts[2] === 'maintenance' && method === 'GET') {
    const records = maintenanceByUnit.get(apparatusId) ?? [];
    return json({ records, nextScheduled: nextScheduled(records) });
  }

  if (parts[2] === 'maintenance' && method === 'POST') {
    const record: MaintenanceRecord = {
      apparatusId,
      performedAt: Math.floor(Date.now() / 1000),
      description: body.description as string,
      vendor: body.vendor as string,
      cost: body.cost as number,
      scheduledNextAt: (body.scheduledNextAt as number | null | undefined) ?? null,
    };
    maintenanceByUnit.set(apparatusId, [record, ...(maintenanceByUnit.get(apparatusId) ?? [])]);
    return json(record, 201);
  }

  if (parts[2] === 'scba' && method === 'POST') {
    const record: ScbaRecord = {
      apparatusId,
      scbaUnitId: body.scbaUnitId as string,
      cylinderId: body.cylinderId as string,
      flowTestDate: body.flowTestDate as string,
      hydroTestDate: body.hydroTestDate as string,
      nextFlowTestDue: addDays(body.flowTestDate as string, FLOW_TEST_INTERVAL_DAYS),
      nextHydroTestDue: addDays(body.hydroTestDate as string, HYDRO_TEST_INTERVAL_DAYS),
    };
    scbaByUnit.set(apparatusId, [record, ...(scbaByUnit.get(apparatusId) ?? [])]);
    return json(record, 201);
  }

  if (parts[2] === 'tests' && method === 'POST') {
    const testType = body.testType as TestingScheduleEntry['testType'];
    const nextDueDate = body.nextDueDate as string;
    const existing = testingSchedule.find(
      (entry) => entry.unitId === unit.unitId && entry.testType === testType,
    );
    if (existing) existing.nextDueDate = nextDueDate;
    else testingSchedule.push({ unitId: unit.unitId, testType, nextDueDate });
    return json({ apparatusId, ...body }, 201);
  }

  if (parts[2] === 'inventory' && parts.length === 3 && method === 'GET') {
    return json({ compartments: inventoryByUnit.get(apparatusId) ?? [] });
  }

  if (parts[2] === 'inventory' && parts.length === 3 && method === 'POST') {
    const compartmentCode = body.compartmentCode as string;
    const groups = inventoryByUnit.get(apparatusId) ?? [];
    let group = groups.find((g) => g.compartmentCode === compartmentCode);
    if (!group) {
      group = { compartmentCode, items: [] };
      groups.push(group);
    }
    const item = {
      itemId: `item-${Date.now()}`,
      itemName: body.itemName as string,
      quantity: body.quantity as number,
    };
    group.items.push(item);
    inventoryByUnit.set(apparatusId, groups);
    return json(item, 201);
  }

  if (parts[2] === 'inventory' && parts.length === 4 && method === 'PUT') {
    const itemId = decodeURIComponent(parts[3] ?? '');
    const groups = inventoryByUnit.get(apparatusId) ?? [];
    for (const group of groups) {
      const item = group.items.find((i) => i.itemId === itemId);
      if (item) {
        item.quantity = body.quantity as number;
        return json({ itemId, quantity: item.quantity });
      }
    }
    return problem(404, 'Inventory item not found');
  }

  return problem(404, 'Not found');
}
