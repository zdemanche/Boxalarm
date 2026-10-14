import { demoAlertsRequest } from '../features/alerts/demoFixtures';
import { incidentsDemoRequest } from '../features/incidents/demoFixtures';
import { apparatusDemoRequest } from '../features/apparatus/demoFixtures';
import type {
  AssignedToType,
  ConsumableStock,
  CreateEquipmentAssetInput,
  EquipmentAsset,
  IssuePpeInput,
  LifecycleStatus,
  PpeAssignment,
} from '../features/inventory/types';
import type {
  CreateHydrantInput,
  CreateOccupancyInput,
  Hydrant,
  Inspection,
  Occupancy,
  PrePlanView,
  PutPrePlanInput,
  UpdateHydrantInput,
  UpdateOccupancyInput,
  Violation,
} from '../features/inspections/types';
import type { CreateMemberInput, Member, MemberStatus } from '../features/personnel/types';
import { KNOWN_ROLES } from '../auth/roles';
import type {
  AuditEntry,
  ConfigResponse,
  ExportStatus,
  RetentionConfig,
} from '../features/platform/types';
import { tryHandleLosapExtras } from '../features/losap/demoFixtures';
import { tryHandleCadSourcesDemo } from '../features/platform/demoFixtures';
import { tryHandleNotificationExtras } from '../features/notifications/demoFixtures';
import { tryHandlePersonnelExtras } from '../features/personnel/demoFixtures';
import { reportingDemoRequest } from '../features/reporting/demoFixtures';
import { tryHandleScheduleExtras } from '../features/schedule/demoFixtures';
import type { ApiRequestOptions, ProblemDetails } from './apiClient';
import {
  DEMO_FLEET,
  DEMO_MEMBERS,
  DEMO_RESPONDING_MEMBER_IDS,
  DEMO_STATION,
  demoMemberName,
} from './demoRoster';
import { trainingDemoRequest } from './trainingDemoFixtures';

// Every date below is relative to when the demo loads, so the data never reads as stale.
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();

/** YYYY-MM-DD for `offsetDays` from today (negative is the past). */
function isoDate(offsetDays: number): string {
  return new Date(NOW + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

/** Epoch milliseconds for `days` ago at a given local wall-clock time. */
function daysAgo(days: number, hour: number, minute = 0): number {
  const date = new Date(NOW - days * DAY_MS);
  date.setHours(hour, minute, 0, 0);
  return date.getTime();
}

/** Deterministic 0..1 for a seed - the fixtures must look the same on every load. */
function hash01(seed: number): number {
  return (((seed + 1) * 2654435761) >>> 0) / 4294967296;
}

const ENGINE_301 = DEMO_FLEET[1].apparatusId;
const RESCUE_300 = DEMO_FLEET[0].apparatusId;
const TRUCK_304 = DEMO_FLEET[2].apparatusId;
const ENGINE_305 = DEMO_FLEET[3].apparatusId;
const SQUAD_309 = DEMO_FLEET[4].apparatusId;

let members: Member[] = [...DEMO_MEMBERS];

function config(
  configType: string,
  value: Record<string, unknown>,
  updatedDaysAgo: number,
  updatedBy: string,
  version = 1,
): [string, ConfigResponse] {
  return [
    configType,
    {
      configType,
      value,
      version,
      updatedAt: new Date(daysAgo(updatedDaysAgo, 10)).toISOString(),
      updatedBy,
    },
  ];
}

// RIDING_POSITIONS is read by the schedule's position picker (lib/useRidingPositions.ts): keyed
// by apparatus type, merged by code, the first definition of a code wins.
const RIDING_POSITIONS_VALUE = {
  ENGINE: [
    { code: 'OFF', label: 'Officer', requiredQual: 'OFFICER' },
    { code: 'DRIVER', label: 'Driver/operator', requiredQual: 'DRIVER_OPERATOR' },
    { code: 'FF', label: 'Firefighter (interior)', requiredQual: 'INTERIOR' },
    { code: 'FF2', label: 'Firefighter (exterior)' },
  ],
  LADDER: [
    { code: 'OFF', label: 'Officer', requiredQual: 'OFFICER' },
    { code: 'DRIVER', label: 'Driver/operator', requiredQual: 'DRIVER_OPERATOR' },
    { code: 'FF', label: 'Firefighter (interior)', requiredQual: 'INTERIOR' },
    { code: 'FF2', label: 'Firefighter (exterior)' },
  ],
  RESCUE: [
    { code: 'OFF', label: 'Officer', requiredQual: 'OFFICER' },
    { code: 'DRIVER', label: 'Driver/operator', requiredQual: 'DRIVER_OPERATOR' },
    { code: 'FF', label: 'Firefighter (interior)', requiredQual: 'INTERIOR' },
  ],
  UTILITY: [{ code: 'DRIVER', label: 'Driver/operator', requiredQual: 'DRIVER_OPERATOR' }],
};

// Keyed by the config type string: RIDING_POSITIONS is read-only on the web, so it is not in
// EditableConfigType, but the same GET serves it. RANKS stays unset (a 404 the tests rely on).
const configStore = new Map<string, ConfigResponse>([
  config(
    'STATIONS',
    { stations: [{ stationId: DEMO_STATION.stationId, name: DEMO_STATION.name }] },
    50,
    'm-31',
    2,
  ),
  config('ALERT_RULES', { escalationThresholdN: 90 }, 60, 'm-2', 2),
  config(
    'LOSAP_POINT_RULES',
    { pointsByActivityType: { CALL: 1, DRILL: 1, MEETING: 1, WORK_DETAIL: 1, STANDBY: 1 } },
    44,
    'm-2',
    3,
  ),
  config('RIDING_POSITIONS', RIDING_POSITIONS_VALUE, 36, 'm-9', 2),
]);

let retentionConfig: RetentionConfig = { retentionYears: 7, version: 2, source: 'stored' };

function audit(
  days: number,
  hour: number,
  actorId: string,
  action: string,
  mutatedEntityType: string,
  mutatedEntityId: string,
  changedFields: AuditEntry['changedFields'] = {},
): AuditEntry {
  return {
    actorId,
    ts: daysAgo(days, hour, Math.round(hash01(days * 24 + hour) * 59)),
    action,
    mutatedEntityType,
    mutatedEntityId,
    changedFields,
  };
}

const diff = (oldValue: unknown, newValue: unknown) => ({ old: oldValue, new: newValue });
/** The equipment writers record only the new value (backend equipmentRepository.ts). */
const setTo = (newValue: unknown) => ({ new: newValue });

const LOSAP_POINTS_V1 = { CALL: 1, DRILL: 1, MEETING: 0, WORK_DETAIL: 1, STANDBY: 0 };
const LOSAP_POINTS_V2 = { ...LOSAP_POINTS_V1, MEETING: 1 };
const LOSAP_POINTS_V3 = { ...LOSAP_POINTS_V2, STANDBY: 1 };

// Shown as examples on the audit page's ID help, so they are the shape the backend mints.
const DEMO_EXPORT_JOB_IDS = [
  '8d3f2c1a-5b7e-4c9d-a2f1-6e0b9c4d7a13',
  'c41e7b20-9a3d-4f6e-8b15-2d7f0a9e6c58',
] as const;
const DEMO_DISPOSAL_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

// The last 60 days of change history. Only types, actions and field shapes the backend really
// writes (and platform/audit can read back): no APPARATUS, INCIDENT, SESSION or config-section
// entries, because no writer files those where the audit page looks. Actors and subjects are
// roster members; every status and role change ends where the roster is today.
const auditEntries: AuditEntry[] = [
  audit(1, 7, 'm-9', 'UPDATE', 'EQUIPMENT_ASSET', 'eq-8', {
    assignedToType: setTo('APPARATUS'),
    assignedToId: setTo(TRUCK_304),
  }),
  audit(3, 16, 'm-9', 'CREATE', 'EQUIPMENT_ASSET', 'eq-3', {
    serialNumber: setTo('RADIO-1187'),
    location: setTo('Quartermaster shelf'),
  }),
  audit(5, 11, 'm-3', 'UPDATE', 'OCCUPANCY', 'occ-6', {
    hazards: diff(
      ['Paint booth, flammable liquids', 'Acetylene cylinders'],
      ['Paint booth, flammable liquids', 'Acetylene cylinders', 'Vehicle lifts'],
    ),
  }),
  audit(8, 19, 'm-9', 'CREATE', 'PPE_ASSIGNMENT', 'helmet', {
    itemType: diff(null, 'helmet'),
    size: diff(null, 'M'),
    issueDate: diff(null, isoDate(-8)),
  }),
  audit(9, 10, 'm-31', 'CREATE', 'EXPORT_JOB', DEMO_EXPORT_JOB_IDS[0]),
  audit(12, 20, 'm-1', 'UPDATE', 'MEMBER', 'm-24', {
    status: diff('PROBATIONARY', 'ACTIVE'),
  }),
  audit(18, 9, 'm-1', 'ARCHIVE', 'HYDRANT', 'HYD-025', {
    archivedAt: diff(null, daysAgo(18, 9, Math.round(hash01(18 * 24 + 9) * 59))),
  }),
  audit(24, 9, 'm-9', 'UPDATE', 'EQUIPMENT_ASSET', 'eq-9', {
    location: setTo('SCBA room, retired rack'),
  }),
  audit(28, 10, 'm-2', 'CREATE', 'EXPORT_JOB', DEMO_EXPORT_JOB_IDS[1]),
  audit(30, 20, 'm-1', 'UPDATE', 'MEMBER', 'm-22', {
    status: diff('PROBATIONARY', 'ACTIVE'),
  }),
  audit(33, 17, 'm-1', 'UPDATE', 'MEMBER', 'm-9', {
    roles: diff(['MEMBER', 'OFFICER'], ['MEMBER', 'OFFICER', 'APPARATUS']),
  }),
  audit(38, 12, 'm-31', 'UPDATE', 'MEMBER', 'm-30', { status: diff('ACTIVE', 'RETIRED') }),
  audit(41, 20, 'm-1', 'UPDATE', 'MEMBER', 'm-7', {
    roles: diff(['MEMBER', 'OFFICER'], ['MEMBER', 'OFFICER', 'TRAINING']),
  }),
  audit(44, 10, 'm-2', 'UPDATE', 'DEPARTMENT_CONFIG', 'LOSAP_POINT_RULES', {
    pointsByActivityType: diff(LOSAP_POINTS_V2, LOSAP_POINTS_V3),
  }),
  audit(45, 21, 'm-1', 'UPDATE', 'MEMBER', 'm-5', { status: diff('ACTIVE', 'LOA') }),
  audit(47, 11, 'm-2', 'DELETE', 'RETENTION_DISPOSAL', DEMO_DISPOSAL_TRACE_ID, {
    retentionYearsUsed: setTo(7),
    hardDeleted: setTo(12),
    cryptoShredded: setTo(3),
    refused: setTo([]),
  }),
  audit(50, 9, 'm-2', 'UPDATE', 'DEPARTMENT_CONFIG', 'LOSAP_POINT_RULES', {
    pointsByActivityType: diff(LOSAP_POINTS_V1, LOSAP_POINTS_V2),
  }),
  audit(52, 19, 'm-1', 'UPDATE', 'MEMBER', 'm-29', { status: diff('ACTIVE', 'LOA') }),
  audit(55, 14, 'm-2', 'UPDATE', 'MEMBER', 'm-31', {
    roles: diff(['MEMBER'], ['MEMBER', 'ADMIN']),
  }),
  audit(60, 10, 'm-2', 'CREATE', 'DEPARTMENT_CONFIG', 'LOSAP_POINT_RULES', {
    pointsByActivityType: diff(null, LOSAP_POINTS_V1),
  }),
];

/** Where an asset sat before its one recorded move (eq-9 went to the retired rack). */
const ASSET_FIRST_LOCATION: Readonly<Record<string, string>> = {
  'eq-9': 'Engine 305, rear seat right',
};

/**
 * Every seeded member, asset and occupancy was entered when the department moved onto
 * Boxalarm, so each record page's Change history opens on at least a "Created" row. A member is
 * created PROBATIONARY (backend createMember) and set to the status they held at the time:
 * the "from" of their first change above, or today's status. Built on first lookup, because
 * the equipment and occupancy lists are declared further down this file.
 */
function onboardingEntries(): AuditEntry[] {
  const firstStatus = new Map<string, unknown>();
  for (const entry of [...auditEntries].reverse()) {
    const status = entry.changedFields.status;
    if (entry.mutatedEntityType === 'MEMBER' && status && !firstStatus.has(entry.mutatedEntityId)) {
      firstStatus.set(entry.mutatedEntityId, status.old);
    }
  }
  const memberEntries = DEMO_MEMBERS.flatMap((member) => {
    const actor = member.memberId === 'm-31' ? 'm-2' : 'm-31';
    const created = audit(90, 9, actor, 'CREATE', 'MEMBER', member.memberId, {
      status: diff(null, 'PROBATIONARY'),
      rank: diff(null, member.rank),
      agencyId: diff(null, member.agencyId),
    });
    const startStatus = firstStatus.get(member.memberId) ?? member.status;
    return startStatus === 'PROBATIONARY'
      ? [created]
      : [
          created,
          audit(90, 10, actor, 'UPDATE', 'MEMBER', member.memberId, {
            status: diff('PROBATIONARY', startStatus),
          }),
        ];
  });
  const createdAssets = new Set(
    auditEntries
      .filter((e) => e.mutatedEntityType === 'EQUIPMENT_ASSET' && e.action === 'CREATE')
      .map((e) => e.mutatedEntityId),
  );
  const assetEntries = equipment
    .filter((item) => !createdAssets.has(item.assetId))
    .map((item) =>
      audit(85, 14, 'm-9', 'CREATE', 'EQUIPMENT_ASSET', item.assetId, {
        serialNumber: setTo(item.serialNumber),
        location: setTo(ASSET_FIRST_LOCATION[item.assetId] ?? item.location),
      }),
    );
  const occupancyEntries = occupancies.map((occ) =>
    audit(80, 11, 'm-3', 'CREATE', 'OCCUPANCY', occ.occupancyId, {
      address: diff(null, occ.address),
      occupancyType: diff(null, occ.occupancyType),
      contacts: diff(null, occ.contacts),
      hazards: diff(
        null,
        // occ-6's hazard list grew later (above); its creation shows the list before that.
        occ.occupancyId === 'occ-6'
          ? occ.hazards.filter((h) => h !== 'Vehicle lifts')
          : occ.hazards,
      ),
    }),
  );
  return [...memberEntries, ...assetEntries, ...occupancyEntries];
}

let auditLog: AuditEntry[] | null = null;

/** Newest first, as platform/audit returns it. */
function demoAuditLog(): AuditEntry[] {
  auditLog ??= [...auditEntries, ...onboardingEntries()].sort((a, b) => b.ts - a.ts);
  return auditLog;
}

function asset(
  assetId: string,
  serialNumber: string,
  location: string,
  lifecycleStatus: LifecycleStatus,
  assignment?: { type: AssignedToType; id: string },
): EquipmentAsset {
  return {
    assetId,
    deptId: 'nichols-fd',
    serialNumber,
    location,
    lifecycleStatus,
    ...(assignment ? { assignedToType: assignment.type, assignedToId: assignment.id } : {}),
  };
}

const onUnit = (id: string) => ({ type: 'APPARATUS' as const, id });
const onMember = (id: string) => ({ type: 'MEMBER' as const, id });

let equipment: EquipmentAsset[] = [
  asset('eq-1', 'SCBA-4471', 'Engine 301, officer seat', 'IN_SERVICE', onUnit(ENGINE_301)),
  asset('eq-2', 'THERM-0092', 'Rescue 300, cab', 'IN_SERVICE', onUnit(RESCUE_300)),
  asset('eq-3', 'RADIO-1187', 'Quartermaster shelf', 'ACQUIRED'),
  asset('eq-4', 'SCBA-4472', 'Engine 301, rear seat left', 'IN_SERVICE', onUnit(ENGINE_301)),
  asset('eq-5', 'SCBA-4473', 'Engine 301, rear seat right', 'IN_SERVICE', onUnit(ENGINE_301)),
  asset('eq-6', 'SCBA-4474', 'Engine 305, officer seat', 'IN_SERVICE', onUnit(ENGINE_305)),
  asset('eq-7', 'SCBA-4475', 'Engine 305, rear seat left', 'IN_SERVICE', onUnit(ENGINE_305)),
  asset('eq-8', 'SCBA-4476', 'Truck 304, rear seat left', 'IN_SERVICE', onUnit(TRUCK_304)),
  asset('eq-9', 'SCBA-4479', 'SCBA room, retired rack', 'RETIRED'),
  asset('eq-10', 'SCBA-4477', 'Rescue 300, rear seat right', 'IN_SERVICE', onUnit(RESCUE_300)),
  asset('eq-11', 'SCBA-4478', 'SCBA room, spare rack', 'ACQUIRED'),
  asset('eq-12', 'THERM-0117', 'Engine 301, officer side', 'IN_SERVICE', onUnit(ENGINE_301)),
  asset('eq-13', 'GASMTR-2210', 'Rescue 300, compartment R1', 'IN_SERVICE', onUnit(RESCUE_300)),
  asset('eq-14', 'HOSE-LDH-500-01', 'Engine 301, hose bed', 'IN_SERVICE', onUnit(ENGINE_301)),
  asset('eq-15', 'HOSE-175-04', 'Engine 305, crosslay 2', 'IN_SERVICE', onUnit(ENGINE_305)),
  asset('eq-16', 'EXTR-0331', 'Rescue 300, compartment L2', 'IN_SERVICE', onUnit(RESCUE_300)),
  asset('eq-17', 'EXTR-0332', 'Rescue 300, compartment L2', 'IN_SERVICE', onUnit(RESCUE_300)),
  asset('eq-18', 'AED-7701', 'Engine 301, cab', 'IN_SERVICE', onUnit(ENGINE_301)),
  asset('eq-19', 'AED-7702', 'Station 1, day room wall', 'IN_SERVICE'),
  asset('eq-20', 'RADIO-1188', 'Issued portable', 'IN_SERVICE', onMember('m-1')),
  asset('eq-21', 'RADIO-1189', 'Issued portable', 'IN_SERVICE', onMember('m-2')),
  asset('eq-22', 'RADIO-1190', 'Issued portable', 'IN_SERVICE', onMember('m-6')),
  asset('eq-23', 'SAW-0450', 'Squad 309, compartment R3', 'IN_SERVICE', onUnit(SQUAD_309)),
];

const PPE_ITEM_TYPES = ['turnout_coat', 'turnout_pants', 'helmet', 'boots'] as const;
type PpeItemType = (typeof PPE_ITEM_TYPES)[number];

// Issue months after the join date, so a set is not all one day.
const PPE_ISSUE_OFFSET_MONTHS: Record<PpeItemType, number> = {
  turnout_coat: 0,
  turnout_pants: 0,
  helmet: 2,
  boots: 1,
};

// Items that were never replaced on the 10-year cycle: two past NFPA 1851 retirement and two
// coming due, so the member page has something to show for them.
const PPE_ISSUE_OVERRIDES: Record<string, string> = {
  'm-23:turnout_coat': '2015-03-02',
  'm-21:boots': '2016-06-01',
  'm-13:helmet': '2016-11-15',
  'm-9:turnout_coat': '2017-01-10',
};

const COAT_SIZES = ['M', 'L', 'L', 'XL', 'S', 'L', 'M'];
const PANTS_SIZES = ['32', '34', '36', '38', '30', '34', '40'];
const BOOT_SIZES = ['9', '10', '11', '12', '8', '10.5', '13'];

function toIsoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function ppeIssueDate(member: Member, itemType: PpeItemType, index: number): string {
  const override = PPE_ISSUE_OVERRIDES[`${member.memberId}:${itemType}`];
  if (override) return override;
  const join = new Date(member.joinDate);
  let issue = new Date(
    Date.UTC(
      join.getUTCFullYear(),
      join.getUTCMonth() + PPE_ISSUE_OFFSET_MONTHS[itemType],
      1 + ((index * 7 + itemType.length) % 27),
    ),
  );
  // Replaced on the NFPA 1851 ten-year cycle until the current set.
  while (issue.getTime() + 10 * 365.25 * DAY_MS <= NOW) {
    issue = new Date(
      Date.UTC(issue.getUTCFullYear() + 10, issue.getUTCMonth(), issue.getUTCDate()),
    );
  }
  return toIsoDay(issue);
}

function ppeSize(itemType: PpeItemType, index: number): string {
  switch (itemType) {
    case 'turnout_coat':
      return COAT_SIZES[index % COAT_SIZES.length] ?? 'L';
    case 'turnout_pants':
      return PANTS_SIZES[index % PANTS_SIZES.length] ?? '34';
    case 'boots':
      return BOOT_SIZES[index % BOOT_SIZES.length] ?? '10';
    case 'helmet':
      return 'Universal';
  }
}

function buildPpeAssignments(): PpeAssignment[] {
  const today = isoDate(0);
  const outfitted = DEMO_MEMBERS.filter(
    (m) => DEMO_RESPONDING_MEMBER_IDS.includes(m.memberId) && m.rank !== 'Administrative Member',
  );
  return outfitted.flatMap((member, index) =>
    PPE_ITEM_TYPES.map((itemType): PpeAssignment => {
      const issueDate = ppeIssueDate(member, itemType, index);
      const nfpaExpiryDate = `${Number(issueDate.slice(0, 4)) + 10}${issueDate.slice(4)}`;
      return {
        ppeItemId: `${itemType.replace(/_/g, '-')}-${member.memberId}`,
        memberId: member.memberId,
        itemType,
        size: ppeSize(itemType, index),
        issueDate,
        nfpaExpiryDate,
        status: nfpaExpiryDate < today ? 'EXPIRED' : 'ISSUED',
      };
    }),
  );
}

let ppeAssignments: PpeAssignment[] = buildPpeAssignments();

function consumable(
  itemId: string,
  itemName: string,
  stockLevel: number,
  reorderThreshold: number,
  location = 'Station 1, supply room',
): ConsumableStock {
  return {
    itemId,
    deptId: 'nichols-fd',
    itemName,
    stockLevel,
    reorderThreshold,
    location,
    reorderFlagged: stockLevel < reorderThreshold,
  };
}

const consumables: ConsumableStock[] = [
  consumable('foam-3pct', 'Class A foam (3%), 5 gal pails', 4, 8, 'Station 1, foam cage'),
  consumable('first-aid', 'First aid kits', 12, 5),
  consumable('absorbent', 'Absorbent (Speedi-Dri), 50 lb bags', 6, 10, 'Station 1, apparatus bay'),
  consumable('scba-cyl-oring', 'SCBA cylinder O-rings', 40, 20, 'SCBA room'),
  consumable('hose-gaskets', 'Hose coupling gaskets, 1.75 and 2.5 in', 24, 12),
  consumable('nitrile-gloves', 'Nitrile gloves, boxes', 18, 10),
  consumable('fuel-mix', '2-stroke saw fuel mix, gal', 5, 4, 'Station 1, flammables cabinet'),
  consumable('batteries-aa', 'AA batteries', 60, 48),
  consumable('fusees', 'Fusees (road flares)', 30, 24, 'Utility 302, compartment L1'),
];

function occupancy(
  occupancyId: string,
  address: string,
  occupancyType: string,
  contacts: Occupancy['contacts'],
  hazards: string[],
  latitude: number,
  longitude: number,
): Occupancy {
  return { occupancyId, address, occupancyType, contacts, hazards, latitude, longitude };
}

let occupancies: Occupancy[] = [
  // occ-1 is referenced by other fixtures - keep it as it is.
  {
    occupancyId: 'occ-1',
    address: '12 Main St, Trumbull CT',
    occupancyType: 'Commercial',
    contacts: [{ name: 'Sam Lee', phone: '203-555-0199', role: 'Manager' }],
    hazards: ['Flammable storage'],
    latitude: 41.24,
    longitude: -73.19,
  },
  occupancy(
    'occ-2',
    'Trumbull Center Plaza, 5065 Main St, Trumbull CT',
    'Mercantile',
    [{ name: 'Dana Pruitt', phone: '203-555-0301', role: 'Property manager' }],
    ['Roof-mounted HVAC units', 'Rear loading dock, limited access'],
    41.2462,
    -73.2015,
  ),
  occupancy(
    'occ-3',
    'Nichols Garden Apartments, 48 White Plains Rd, Trumbull CT',
    'Multi-family residential',
    [
      { name: 'Ray Castellano', phone: '203-555-0318', role: 'Superintendent' },
      { name: 'Harbor Point Management', phone: '203-555-0319', role: 'Owner' },
    ],
    ['Three-story wood frame, no sprinklers', 'Knox box at building A entrance'],
    41.2518,
    -73.1934,
  ),
  occupancy(
    'occ-4',
    'Daniels Farm Self Storage, 210 Daniels Farm Rd, Trumbull CT',
    'Storage',
    [{ name: 'Kelly Marsh', phone: '203-555-0327', role: 'Site manager' }],
    ['Unknown stored contents', 'Roll-up doors, forcible entry needed', 'Gated lot, Knox key'],
    41.2608,
    -73.2124,
  ),
  occupancy(
    'occ-5',
    'Church Hill Commons, 77 Church Hill Rd, Trumbull CT',
    'Assembly',
    [{ name: 'Rev. Anne Kowalski', phone: '203-555-0334', role: 'Pastor' }],
    ['Occupant load 300', 'Basement kitchen, propane range'],
    41.2434,
    -73.2119,
  ),
  occupancy(
    'occ-6',
    'Huntington Turnpike Auto Body, 3310 Huntington Tpke, Trumbull CT',
    'Repair garage',
    [{ name: 'Vinnie Caruso', phone: '203-555-0342', role: 'Owner' }],
    ['Paint booth, flammable liquids', 'Acetylene cylinders', 'Vehicle lifts'],
    41.2401,
    -73.1762,
  ),
  occupancy(
    'occ-7',
    'Reservoir Avenue Pump Station, 100 Reservoir Ave, Trumbull CT',
    'Utility',
    [{ name: 'Aquarion control room', phone: '203-555-0350', role: '24-hour operator' }],
    ['Chlorine storage', 'Confined spaces', '480V switchgear'],
    41.2447,
    -73.1844,
  ),
  occupancy(
    'occ-8',
    'Nichols Village Apartments, 1500 Nichols Ave, Trumbull CT',
    'Multi-family residential',
    [{ name: 'Monica Reyes-Bell', phone: '203-555-0366', role: 'Property manager' }],
    ['Four buildings, 48 units', 'Standpipe, no sprinklers', 'Underground garage, building C'],
    41.2561,
    -73.2069,
  ),
  occupancy(
    'occ-9',
    'Shelton Road Hardware, 2140 Shelton Rd, Trumbull CT',
    'Mercantile',
    [{ name: 'Gus Petrakis', phone: '203-555-0371', role: 'Owner' }],
    ['Propane cylinder exchange cage', 'Pesticide and fertilizer storage', 'Ammunition display'],
    41.2669,
    -73.1818,
  ),
  occupancy(
    'occ-10',
    'Route 111 Medical Arts Building, 6515 Route 111, Trumbull CT',
    'Business',
    [{ name: 'Northeast Medical Properties', phone: '203-555-0385', role: 'Facilities' }],
    ['Oxygen cylinders', 'MRI suite, magnetic hazard', 'Sprinklered'],
    41.2688,
    -73.2203,
  ),
  occupancy(
    'occ-11',
    'Old Town Road Assisted Living, 320 Old Town Rd, Trumbull CT',
    'Institutional',
    [
      { name: 'Nurse station, east wing', phone: '203-555-0390', role: '24-hour contact' },
      { name: 'Linda Ferraro', phone: '203-555-0391', role: 'Administrator' },
    ],
    ['60 non-ambulatory residents', 'Oxygen in use', 'Sprinklered, FDC on Old Town Rd side'],
    41.2553,
    -73.2256,
  ),
  occupancy(
    'occ-12',
    'Madison Avenue Elementary School, 870 Madison Ave, Trumbull CT',
    'Educational',
    [{ name: 'Principal Joan Whitaker', phone: '203-555-0402', role: 'Principal' }],
    ['Occupant load 450 during school hours', 'Natural gas boilers, basement'],
    41.2492,
    -73.2178,
  ),
  occupancy(
    'occ-13',
    'Hawley Lane Office Park, 55 Hawley Ln, Trumbull CT',
    'Business',
    [{ name: 'Cornerstone Realty', phone: '203-555-0415', role: 'Property manager' }],
    ['Three-story steel frame', 'Diesel generator, 500 gal tank'],
    41.2407,
    -73.2275,
  ),
];

function prePlan(
  occupancyId: string,
  siteDiagramFilename: string | null,
  attachmentFilenames: string[],
  utilityShutoffs: PrePlanView['utilityShutoffs'],
  hazards: string[],
): [string, PrePlanView] {
  return [
    occupancyId,
    {
      prePlanId: `preplan-${occupancyId}`,
      siteDiagramS3Key: siteDiagramFilename,
      ...(siteDiagramFilename ? { siteDiagramUrl: `demo://${siteDiagramFilename}` } : {}),
      attachmentS3Keys: attachmentFilenames,
      attachmentUrls: attachmentFilenames.map((filename) => ({
        key: filename,
        url: `demo://${filename}`,
      })),
      utilityShutoffs,
      hazards,
    },
  ];
}

const prePlans: Record<string, PrePlanView> = Object.fromEntries([
  prePlan(
    'occ-3',
    'nichols-garden-site-plan.pdf',
    ['nichols-garden-building-b-floor-1.pdf', 'knox-box-location.jpg'],
    [
      { utility: 'Gas', location: 'Meter bank, north wall of building A' },
      { utility: 'Electric', location: 'Main disconnect, utility room, building A basement' },
      { utility: 'Water', location: 'Curb box at the White Plains Rd driveway' },
    ],
    ['No sprinklers', 'Common attic across each building', 'Nearest hydrant HYD-007 at driveway'],
  ),
  prePlan(
    'occ-6',
    'huntington-auto-body-site.pdf',
    ['sds-binder-index.pdf'],
    [
      { utility: 'Gas', location: 'Meter, east side near the paint booth exhaust' },
      { utility: 'Electric', location: 'Panel room, rear left of the shop floor' },
      { utility: 'Compressed air', location: 'Compressor shutoff, north wall' },
    ],
    [
      'Paint booth, about 300 gal flammable liquids',
      'Acetylene and oxygen cylinders in the rear bay',
      'Vehicle lifts - do not work under a raised vehicle',
    ],
  ),
  prePlan(
    'occ-7',
    null,
    ['chlorine-emergency-plan.pdf'],
    [
      { utility: 'Electric', location: '480V main, switchgear room - utility must de-energize' },
      { utility: 'Chlorine', location: 'Cylinder valves, chlorine room - SCBA required' },
    ],
    [
      'Chlorine, 150 lb cylinders',
      'Confined space: wet well',
      'No interior operations before Aquarion is on scene',
    ],
  ),
  prePlan(
    'occ-11',
    'old-town-assisted-living-evac-plan.pdf',
    ['resident-count-by-wing.pdf', 'fdc-and-riser-photos.pdf'],
    [
      { utility: 'Gas', location: 'Meter, kitchen loading dock' },
      { utility: 'Electric', location: 'Main switchgear, basement mechanical room' },
      { utility: 'Sprinkler', location: 'Riser room off the main lobby; FDC on Old Town Rd side' },
      { utility: 'Oxygen', location: 'Bulk O2 shutoff, exterior east wall' },
    ],
    [
      '60 non-ambulatory residents',
      'Oxygen in use in resident rooms',
      'Defend in place; staff evacuate by wing',
    ],
  ),
  prePlan(
    'occ-12',
    'madison-elementary-floor-plan.pdf',
    [],
    [
      { utility: 'Gas', location: 'Meter at the boiler room exterior door, north side' },
      { utility: 'Electric', location: 'Main panel, boiler room' },
    ],
    ['Occupant load 450 during school hours', 'Natural gas boilers', 'Flat roof, 4 roof hatches'],
  ),
]);

const HYDRANT_SIZES = ['4 inch', '5 inch', '6 inch'];

function hydrant(n: number): Hydrant {
  const hydrantId = `HYD-${String(n).padStart(3, '0')}`;
  // HYD-014 and HYD-022 are referenced elsewhere - their records stay as they were.
  if (n === 14) {
    return {
      hydrantId,
      latitude: 41.241,
      longitude: -73.191,
      size: '5 inch',
      flowRatingGpm: 1000,
      lastFlowTestDate: isoDate(-183),
      nextFlowTestDue: '2027-04-01',
      status: 'IN_SERVICE',
    };
  }
  if (n === 22) {
    return {
      hydrantId,
      latitude: 41.238,
      longitude: -73.188,
      size: '4 inch',
      flowRatingGpm: 750,
      lastFlowTestDate: isoDate(-340),
      nextFlowTestDue: '2026-11-01',
      status: 'OUT_OF_SERVICE',
    };
  }
  const overdue = n === 5 || n === 17;
  const lastTestDaysAgo = overdue ? 400 + n : 30 + Math.round(hash01(n) * 300);
  return {
    hydrantId,
    latitude: Number((41.24 + ((n * 7) % 30) / 1000 + hash01(n * 3) / 2000).toFixed(5)),
    longitude: Number((-73.23 + ((n * 11) % 60) / 1000 + hash01(n * 5) / 2000).toFixed(5)),
    size: HYDRANT_SIZES[n % 3] ?? '5 inch',
    flowRatingGpm: 500 + ((n * 137) % 11) * 100,
    lastFlowTestDate: isoDate(-lastTestDaysAgo),
    nextFlowTestDue: isoDate(365 - lastTestDaysAgo),
    status: n === 9 ? 'OUT_OF_SERVICE' : 'IN_SERVICE',
  };
}

let hydrants: Hydrant[] = Array.from({ length: 24 }, (_, i) => hydrant(i + 1));

function inspection(
  inspectionId: string,
  occupancyId: string,
  scheduledOffsetDays: number,
  conducted?: { offsetDays: number; by: string; violations?: Violation[] },
): Inspection {
  return {
    occupancyId,
    inspectionId,
    scheduledDate: isoDate(scheduledOffsetDays),
    violations: conducted?.violations ?? [],
    nextDueDate: conducted ? isoDate(conducted.offsetDays + 365) : isoDate(scheduledOffsetDays),
    ...(conducted
      ? { conductedDate: isoDate(conducted.offsetDays), conductedBy: demoMemberName(conducted.by) }
      : {}),
  };
}

const violation = (code: string, description: string, status: Violation['status']): Violation => ({
  code,
  description,
  status,
});

// Completed with and without violations, scheduled, and overdue (scheduled in the past, never
// conducted). Conducted-by is the inspector's name, as the page prints it.
let inspections: Inspection[] = [
  inspection('insp-1', 'occ-1', -3),
  inspection('insp-2', 'occ-3', -21, {
    offsetDays: -20,
    by: 'm-11',
    violations: [
      violation(
        'NFPA 10 7.3.1',
        'Fire extinguisher in building B first-floor hallway missing its annual tag',
        'open',
      ),
      violation('NFPA 101 7.10.5', 'Exit sign over the rear stairwell door not lit', 'resolved'),
    ],
  }),
  inspection('insp-3', 'occ-2', -45, { offsetDays: -45, by: 'm-11' }),
  inspection('insp-4', 'occ-6', -12, {
    offsetDays: -12,
    by: 'm-3',
    violations: [
      violation('NFPA 33 9.4', 'Spray booth exhaust filters past the replacement date', 'open'),
      violation(
        'NFPA 70 400.8',
        'Extension cords used as permanent wiring for the compressor',
        'open',
      ),
      violation(
        'NFPA 55 7.1.8',
        'Acetylene cylinders stored unsecured in the rear bay',
        'resolved',
      ),
    ],
  }),
  inspection('insp-5', 'occ-7', 9),
  inspection('insp-6', 'occ-11', -60, { offsetDays: -60, by: 'm-11' }),
  inspection('insp-7', 'occ-12', -75, {
    offsetDays: -75,
    by: 'm-6',
    violations: [violation('NFPA 101 7.2.1.8', 'Boiler room fire door propped open', 'resolved')],
  }),
  inspection('insp-8', 'occ-4', -14),
  inspection('insp-9', 'occ-9', -5, {
    offsetDays: -4,
    by: 'm-11',
    violations: [
      violation('NFPA 58 8.4.1', 'Propane exchange cage within 5 ft of a building opening', 'open'),
    ],
  }),
  inspection('insp-10', 'occ-5', 3),
  inspection('insp-11', 'occ-8', 21),
  inspection('insp-12', 'occ-10', -30, { offsetDays: -30, by: 'm-3' }),
  inspection('insp-13', 'occ-13', 40),
  inspection('insp-14', 'occ-3', 12),
  inspection('insp-15', 'occ-6', 18),
];

let exportJobId = 0;

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

export async function demoRequest(
  path: string,
  options: ApiRequestOptions = {},
): Promise<Response> {
  const method = (options.method ?? 'GET').toUpperCase();
  const body = options.body ? (JSON.parse(options.body as string) as Record<string, unknown>) : {};
  const [requestPath, queryString] = path.split('?');
  path = requestPath ?? path;
  const query = new URLSearchParams(queryString ?? '');
  const parts = path.split('/');

  if (parts[0] === 'incidents') {
    const incidentsResponse = await incidentsDemoRequest(path, method, body, query);
    if (incidentsResponse) return incidentsResponse;
  }

  const trainingResponse = await trainingDemoRequest(path, options);
  if (trainingResponse) return trainingResponse;

  const alertsResponse = demoAlertsRequest(path, method, body);
  if (alertsResponse) return alertsResponse;

  if (parts[0] === 'apparatus') {
    const response = await apparatusDemoRequest(path, method, body);
    if (response) return response;
  }

  const reportingResponse = reportingDemoRequest(path, method, query, body);
  if (reportingResponse) return reportingResponse;

  if (path === 'personnel/members' && method === 'GET') return json({ items: members });

  if (path === 'personnel/members' && method === 'POST') {
    const input = body as unknown as CreateMemberInput;
    const created: Member = {
      memberId: `m-${members.length + 1}`,
      status: 'PROBATIONARY',
      roles: ['MEMBER'],
      ...input,
    };
    members = [...members, created];
    return json(created, 201);
  }

  if (
    parts[0] === 'personnel' &&
    parts[1] === 'members' &&
    parts.length === 3 &&
    method === 'GET'
  ) {
    const found = members.find((m) => m.memberId === decodeURIComponent(parts[2] ?? ''));
    return found ? json(found) : problem(404, 'Member not found');
  }

  if (
    parts[0] === 'personnel' &&
    parts[1] === 'members' &&
    parts[3] === 'status' &&
    method === 'PUT'
  ) {
    const id = decodeURIComponent(parts[2] ?? '');
    const status = (body as { status: MemberStatus }).status;
    let updated: Member | undefined;
    members = members.map((m) => {
      if (m.memberId !== id) return m;
      updated = { ...m, status };
      return updated;
    });
    return updated ? json(updated) : problem(404, 'Member not found');
  }

  if (
    parts[0] === 'personnel' &&
    parts[1] === 'members' &&
    parts[3] === 'roles' &&
    method === 'PUT'
  ) {
    const id = decodeURIComponent(parts[2] ?? '');
    const requested = (body as { roles?: unknown }).roles;
    if (
      !Array.isArray(requested) ||
      requested.some((r) => !(KNOWN_ROLES as readonly unknown[]).includes(r))
    ) {
      return problem(400, `roles must contain only: ${KNOWN_ROLES.join(', ')}`);
    }
    const found = members.find((m) => m.memberId === id);
    if (!found) return problem(404, `no member found with id ${id}`);
    // Same normalization as the server: canonical order, deduped, MEMBER always kept.
    const roles = KNOWN_ROLES.filter((r) => r === 'MEMBER' || requested.includes(r));
    const before = found.roles ?? ['MEMBER'];
    const changed = before.length !== roles.length || roles.some((r) => !before.includes(r));
    members = members.map((m) => (m.memberId === id ? { ...m, roles } : m));
    return json({
      memberId: id,
      roles,
      changed,
      takesEffect:
        "The change applies when the member's app next refreshes its session, within one hour.",
    });
  }

  if (parts[0] === 'platform' && parts[1] === 'cad-sources') {
    const cadResponse = tryHandleCadSourcesDemo(parts, method, body);
    if (cadResponse) return cadResponse;
  }

  if (parts[0] === 'platform' && parts[1] === 'config' && parts.length === 3) {
    const configType = decodeURIComponent(parts[2] ?? '');
    if (method === 'GET') {
      const stored = configStore.get(configType);
      return stored ? json(stored) : problem(404, `config ${configType} not found`);
    }
    if (method === 'PUT') {
      const existing = configStore.get(configType);
      const nextVersion = (existing?.version ?? 0) + 1;
      const saved: ConfigResponse = {
        configType,
        value: (body as { value: Record<string, unknown> }).value,
        version: nextVersion,
        updatedAt: new Date().toISOString(),
        updatedBy: 'demo-admin',
      };
      configStore.set(configType, saved);
      return json(saved);
    }
  }

  if (path.startsWith('platform/audit') && method === 'GET') {
    // As platform-service/audit/handler.ts: one record's history, both keys required and
    // matched exactly (a different case is a different record), 25 a page, newest first.
    const entityType = query.get('entityType') ?? '';
    const entityId = query.get('entityId') ?? '';
    if (!entityType || !entityId || /[,#]/.test(entityType + entityId)) {
      return json(
        {
          type: 'about:blank',
          title: 'Bad Request',
          status: 400,
          detail:
            'entityType and entityId query parameters are required and must not contain "," or "#".',
          traceId: 'demo',
        },
        400,
      );
    }
    const matches = demoAuditLog().filter(
      (entry) => entry.mutatedEntityType === entityType && entry.mutatedEntityId === entityId,
    );
    const start = Number(query.get('cursor') ?? 0) || 0;
    const end = start + 25;
    return json({
      entries: matches.slice(start, end),
      ...(end < matches.length ? { nextCursor: String(end) } : {}),
    });
  }

  if (path === 'platform/export' && method === 'POST') {
    exportJobId += 1;
    return json({ jobId: `demo-export-${exportJobId}` }, 202);
  }

  if (parts[0] === 'platform' && parts[1] === 'export' && parts.length === 3 && method === 'GET') {
    const status: ExportStatus = {
      status: 'COMPLETE',
      files: [{ table: 'members', url: '#demo-export-members' }],
    };
    return json(status);
  }

  if (path === 'platform/retention' && method === 'GET') {
    return json(retentionConfig);
  }

  if (path === 'platform/retention' && method === 'PUT') {
    const retentionYears = (body as { retentionYears: number }).retentionYears;
    retentionConfig = {
      retentionYears,
      version: (retentionConfig.version ?? 0) + 1,
      source: 'stored',
    };
    return json(retentionConfig);
  }

  if (parts[0] === 'platform' && parts[1] === 'sessions' && parts[3] === 'devices') {
    const memberId = decodeURIComponent(parts[2] ?? '');
    const now = Date.now();
    return json({
      memberId,
      devices: [
        {
          deviceId: 'demo-install-7f3a9c',
          platform: 'APNS',
          registeredAt: now - 3_600_000,
          valid: true,
        },
        {
          deviceId: 'demo-install-41be02',
          platform: 'FCM',
          registeredAt: now - 86_400_000 * 9,
          valid: true,
        },
      ],
    });
  }

  if (path === 'platform/sessions/revoke' && method === 'POST') {
    const { memberId, deviceId } = body as { memberId: string; deviceId?: string };
    return json(
      { memberId, status: 'revoked', push: 'invalidated', ...(deviceId ? { deviceId } : {}) },
      202,
    );
  }

  if (path === 'platform/sessions/reset-credentials' && method === 'POST') {
    const memberId = (body as { memberId: string }).memberId;
    return json({ memberId, status: 'password-reset-and-signed-out' }, 202);
  }

  if (path === 'inventory/equipment' && method === 'GET') {
    const assignedToType = query.get('assignedToType');
    const assignedToId = query.get('assignedToId');
    const filtered = equipment.filter(
      (a) =>
        (!assignedToType || a.assignedToType === assignedToType) &&
        (!assignedToId || a.assignedToId === assignedToId),
    );
    return json({ items: filtered });
  }

  if (path === 'inventory/equipment' && method === 'POST') {
    const input = body as unknown as CreateEquipmentAssetInput;
    const created: EquipmentAsset = {
      assetId: `eq-${equipment.length + 1}`,
      deptId: 'nichols-fd',
      serialNumber: input.serialNumber,
      location: input.location,
      lifecycleStatus: 'ACQUIRED',
    };
    equipment = [...equipment, created];
    return json(created, 201);
  }

  if (
    parts[0] === 'inventory' &&
    parts[1] === 'equipment' &&
    parts.length === 3 &&
    method === 'GET'
  ) {
    const found = equipment.find((a) => a.assetId === decodeURIComponent(parts[2] ?? ''));
    return found ? json(found) : problem(404, 'Equipment asset not found');
  }

  if (
    parts[0] === 'inventory' &&
    parts[1] === 'equipment' &&
    parts[3] === 'assignment' &&
    method === 'PUT'
  ) {
    const assetId = decodeURIComponent(parts[2] ?? '');
    const { assignedToType, assignedToId } = body as {
      assignedToType: AssignedToType;
      assignedToId: string;
    };
    let updated: EquipmentAsset | undefined;
    equipment = equipment.map((a) => {
      if (a.assetId !== assetId) return a;
      updated = { ...a, assignedToType, assignedToId };
      return updated;
    });
    return updated ? json(updated) : problem(404, 'Equipment asset not found');
  }

  if (
    parts[0] === 'inventory' &&
    parts[1] === 'equipment' &&
    parts[3] === 'location' &&
    method === 'PUT'
  ) {
    const assetId = decodeURIComponent(parts[2] ?? '');
    const { location } = body as { location: string };
    let updated: EquipmentAsset | undefined;
    equipment = equipment.map((a) => {
      if (a.assetId !== assetId) return a;
      updated = { ...a, location };
      return updated;
    });
    return updated ? json(updated) : problem(404, 'Equipment asset not found');
  }

  if (
    parts[0] === 'inventory' &&
    parts[1] === 'equipment' &&
    parts[3] === 'lifecycle' &&
    method === 'PUT'
  ) {
    const assetId = decodeURIComponent(parts[2] ?? '');
    const { lifecycleStatus } = body as { lifecycleStatus: LifecycleStatus };
    let updated: EquipmentAsset | undefined;
    equipment = equipment.map((a) => {
      if (a.assetId !== assetId) return a;
      updated = { ...a, lifecycleStatus };
      return updated;
    });
    return updated
      ? json({ assetId: updated.assetId, lifecycleStatus: updated.lifecycleStatus })
      : problem(404, 'Equipment asset not found');
  }

  if (path === 'inventory/consumables' && method === 'GET') return json({ items: consumables });

  if (parts[0] === 'inventory' && parts[1] === 'ppe' && parts.length === 3 && method === 'GET') {
    const memberId = decodeURIComponent(parts[2] ?? '');
    return json(ppeAssignments.filter((p) => p.memberId === memberId));
  }

  if (parts[0] === 'inventory' && parts[1] === 'ppe' && parts.length === 3 && method === 'POST') {
    const memberId = decodeURIComponent(parts[2] ?? '');
    const input = body as unknown as IssuePpeInput;
    const nfpaExpiryDate = `${Number(input.issueDate.slice(0, 4)) + 10}${input.issueDate.slice(4)}`;
    const created: PpeAssignment = {
      ppeItemId: input.itemType.replace(/_/g, '-'),
      memberId,
      itemType: input.itemType,
      size: input.size,
      issueDate: input.issueDate,
      nfpaExpiryDate,
      status: 'ISSUED',
    };
    ppeAssignments = [...ppeAssignments, created];
    return json(created, 201);
  }

  if (path === 'inspections/occupancies' && method === 'GET') return json({ items: occupancies });

  if (path === 'inspections/occupancies' && method === 'POST') {
    const input = body as unknown as CreateOccupancyInput;
    const created: Occupancy = { occupancyId: `occ-${occupancies.length + 1}`, ...input };
    occupancies = [...occupancies, created];
    return json(created, 201);
  }

  if (
    parts[0] === 'inspections' &&
    parts[1] === 'occupancies' &&
    parts.length === 3 &&
    method === 'GET'
  ) {
    const found = occupancies.find((o) => o.occupancyId === decodeURIComponent(parts[2] ?? ''));
    return found ? json(found) : problem(404, 'Occupancy not found');
  }

  if (
    parts[0] === 'inspections' &&
    parts[1] === 'occupancies' &&
    parts.length === 3 &&
    method === 'PUT'
  ) {
    const occupancyId = decodeURIComponent(parts[2] ?? '');
    const input = body as unknown as UpdateOccupancyInput;
    let updated: Occupancy | undefined;
    occupancies = occupancies.map((o) => {
      if (o.occupancyId !== occupancyId) return o;
      updated = { ...o, ...input };
      return updated;
    });
    return updated ? json(updated) : problem(404, 'Occupancy not found');
  }

  if (
    parts[0] === 'inspections' &&
    parts[1] === 'occupancies' &&
    parts[3] === 'pre-plan' &&
    method === 'GET'
  ) {
    const occupancyId = decodeURIComponent(parts[2] ?? '');
    const prePlan = prePlans[occupancyId];
    return prePlan ? json(prePlan) : problem(404, 'No pre-plan on file');
  }

  if (
    parts[0] === 'inspections' &&
    parts[1] === 'occupancies' &&
    parts[3] === 'pre-plan' &&
    method === 'PUT'
  ) {
    const occupancyId = decodeURIComponent(parts[2] ?? '');
    const input = body as unknown as PutPrePlanInput;
    const prePlanId = prePlans[occupancyId]?.prePlanId ?? `preplan-${occupancyId}`;
    // Replaces the record like the real PUT: an omitted diagram or attachment is removed.
    prePlans[occupancyId] = {
      prePlanId,
      siteDiagramS3Key: input.siteDiagramFilename ?? null,
      ...(input.siteDiagramFilename
        ? { siteDiagramUrl: `demo://${input.siteDiagramFilename}` }
        : {}),
      attachmentS3Keys: input.attachmentFilenames,
      attachmentUrls: input.attachmentFilenames.map((filename) => ({
        key: filename,
        url: `demo://${filename}`,
      })),
      utilityShutoffs: input.utilityShutoffs,
      hazards: input.hazards,
    };
    // No upload URLs: the demo keeps no file bytes, and the browser refuses to PUT to a
    // demo:// URL, which failed every demo save that added a file. With none, the page
    // uploads nothing and the save completes.
    return json({
      prePlanId,
      attachmentUploadUrls: [],
      utilityShutoffs: input.utilityShutoffs,
      hazards: input.hazards,
    });
  }

  if (path.startsWith('inspections/hydrants') && method === 'GET') return json({ hydrants });

  if (path === 'inspections/hydrants' && method === 'POST') {
    const input = body as unknown as CreateHydrantInput;
    const created: Hydrant = { status: 'IN_SERVICE', ...input };
    hydrants = [...hydrants, created];
    return json(created, 201);
  }

  if (
    parts[0] === 'inspections' &&
    parts[1] === 'hydrants' &&
    parts.length === 3 &&
    method === 'PUT'
  ) {
    const hydrantId = decodeURIComponent(parts[2] ?? '');
    const input = body as unknown as UpdateHydrantInput;
    let updated: Hydrant | undefined;
    hydrants = hydrants.map((h) => {
      if (h.hydrantId !== hydrantId) return h;
      updated = { ...h, ...input };
      return updated;
    });
    return updated ? json(updated) : problem(404, 'Hydrant not found');
  }

  if (path.startsWith('inspections/map') && method === 'GET') {
    return json({
      occupancies: occupancies
        .filter((o) => o.latitude !== undefined && o.longitude !== undefined)
        .map((o) => ({ occupancyId: o.occupancyId, latitude: o.latitude, longitude: o.longitude })),
      hydrants: hydrants.map((h) => ({
        hydrantId: h.hydrantId,
        latitude: h.latitude,
        longitude: h.longitude,
        status: h.status,
      })),
    });
  }

  if (path.startsWith('inspections') && !path.includes('/') && method === 'GET') {
    return json({ items: inspections });
  }

  if (path === 'inspections' && method === 'POST') {
    const bodyRecord = body as {
      occupancyId: string;
      scheduledDate?: string;
      inspectionId?: string;
      violations?: Violation[];
    };
    if (bodyRecord.inspectionId) {
      let updated: Inspection | undefined;
      inspections = inspections.map((i) => {
        if (i.inspectionId !== bodyRecord.inspectionId) return i;
        updated = {
          ...i,
          conductedDate: new Date().toISOString(),
          conductedBy: 'demo-user',
          violations: bodyRecord.violations ?? [],
        };
        return updated;
      });
      return updated ? json(updated) : problem(404, 'Inspection not found');
    }
    const created: Inspection = {
      occupancyId: bodyRecord.occupancyId,
      inspectionId: `insp-${inspections.length + 1}`,
      scheduledDate: bodyRecord.scheduledDate ?? '',
      violations: [],
      nextDueDate: bodyRecord.scheduledDate ?? '',
    };
    inspections = [...inspections, created];
    return json(created, 201);
  }

  const extras =
    tryHandleScheduleExtras(parts, method, body) ??
    tryHandlePersonnelExtras(parts, method, body) ??
    tryHandleLosapExtras(parts, method, body) ??
    tryHandleNotificationExtras(parts, method, body);
  if (extras) return extras;

  return problem(404, 'Not found');
}
