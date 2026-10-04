import type { Member } from '../features/personnel/types';

/**
 * The one demo roster every fixture file keys on. Demo-mode data for members, alerts,
 * incidents, training, schedule, reporting and notifications all reference these ids, so
 * a name shown anywhere in the demo resolves here and nowhere else.
 *
 * Fictional people; the department, station and apparatus numbering follow the tenant-zero
 * conventions used elsewhere in the fixtures (Nichols FD, Station 1, 300-series units).
 * Member ids m-1 … m-5 are load-bearing for unit tests — keep them stable.
 */
type Seed = [
  id: string,
  first: string,
  last: string,
  rank: string,
  status: Member['status'],
  joinDate: string,
  roles: NonNullable<Member['roles']>,
];

const SEEDS: readonly Seed[] = [
  ['m-1', 'Alex', 'Rivera', 'Chief', 'ACTIVE', '2018-04-12', ['MEMBER', 'CHIEF']],
  ['m-2', 'Jordan', 'Osei', 'Deputy Chief', 'ACTIVE', '2015-09-01', ['MEMBER', 'OFFICER', 'ADMIN']],
  ['m-3', 'Casey', 'Nolan', 'Captain', 'ACTIVE', '2019-06-20', ['MEMBER', 'OFFICER']],
  ['m-4', 'Priya', 'Shah', 'Firefighter', 'PROBATIONARY', '2025-11-03', ['MEMBER']],
  ['m-5', 'Miguel', 'Torres', 'Firefighter', 'LOA', '2012-02-14', ['MEMBER']],
  ['m-6', 'Dana', 'Whitfield', 'Assistant Chief', 'ACTIVE', '2009-03-02', ['MEMBER', 'OFFICER']],
  ['m-7', 'Marcus', 'Bell', 'Captain', 'ACTIVE', '2013-10-15', ['MEMBER', 'OFFICER', 'TRAINING']],
  ['m-8', 'Elena', 'Petrova', 'Lieutenant', 'ACTIVE', '2016-05-09', ['MEMBER', 'OFFICER']],
  [
    'm-9',
    'Tom',
    'Gallagher',
    'Lieutenant',
    'ACTIVE',
    '2014-01-20',
    ['MEMBER', 'OFFICER', 'APPARATUS'],
  ],
  ['m-10', 'Samira', 'Haddad', 'Lieutenant', 'ACTIVE', '2017-08-28', ['MEMBER', 'OFFICER']],
  ['m-11', 'Luis', 'Ortega', 'Safety Officer', 'ACTIVE', '2008-06-11', ['MEMBER', 'OFFICER']],
  ['m-12', 'Grace', 'Kim', 'Engineer', 'ACTIVE', '2015-02-02', ['MEMBER']],
  ['m-13', 'Derek', 'Lindqvist', 'Engineer', 'ACTIVE', '2011-11-30', ['MEMBER']],
  ['m-14', 'Aisha', 'Mensah', 'Engineer', 'ACTIVE', '2018-09-17', ['MEMBER']],
  ['m-15', 'Ryan', "O'Connell", 'Firefighter', 'ACTIVE', '2020-02-03', ['MEMBER']],
  ['m-16', 'Natalie', 'Brooks', 'Firefighter', 'ACTIVE', '2019-10-07', ['MEMBER']],
  ['m-17', 'Kevin', 'Nakamura', 'Firefighter', 'ACTIVE', '2021-03-15', ['MEMBER']],
  ['m-18', 'Sofia', 'Marchetti', 'Firefighter', 'ACTIVE', '2017-06-26', ['MEMBER']],
  ['m-19', 'Andre', 'Dubois', 'Firefighter', 'ACTIVE', '2022-01-10', ['MEMBER']],
  ['m-20', 'Hannah', 'Feldman', 'Firefighter', 'ACTIVE', '2020-08-24', ['MEMBER']],
  ['m-21', 'Chris', 'Okafor', 'Firefighter', 'ACTIVE', '2016-04-18', ['MEMBER']],
  ['m-22', 'Megan', 'Sullivan', 'Firefighter', 'ACTIVE', '2023-05-01', ['MEMBER']],
  ['m-23', 'Victor', 'Reyes', 'Firefighter', 'ACTIVE', '2014-07-07', ['MEMBER']],
  ['m-24', 'Olivia', 'Chen', 'Firefighter', 'ACTIVE', '2022-09-12', ['MEMBER']],
  ['m-25', 'Ben', 'Carter', 'Fire Police', 'ACTIVE', '2006-10-02', ['MEMBER']],
  ['m-26', 'Paul', 'Jankowski', 'Fire Police', 'ACTIVE', '2004-03-22', ['MEMBER']],
  ['m-27', 'Jamal', 'Washington', 'Firefighter', 'PROBATIONARY', '2026-02-02', ['MEMBER']],
  ['m-28', 'Lily', 'Nguyen', 'Firefighter', 'PROBATIONARY', '2026-06-15', ['MEMBER']],
  ['m-29', 'Frank', 'DeLuca', 'Firefighter', 'LOA', '2010-05-10', ['MEMBER']],
  ['m-30', 'Walter', 'Hayes', 'Firefighter', 'RETIRED', '1998-09-14', ['MEMBER']],
  ['m-31', 'Maria', 'Santos', 'Administrative Member', 'ACTIVE', '2021-01-04', ['MEMBER', 'ADMIN']],
];

function emailFor(first: string, last: string): string {
  const handle = `${first[0] ?? ''}${last}`.toLowerCase().replace(/[^a-z]/g, '');
  return `${handle}@nicholsfd.org`;
}

export const DEMO_MEMBERS: readonly Member[] = SEEDS.map(
  ([memberId, firstName, lastName, rank, status, joinDate, roles], index) => ({
    memberId,
    firstName,
    lastName,
    email: emailFor(firstName, lastName),
    phone: `203-555-${String(111 + index * 11).padStart(4, '0')}`,
    status,
    joinDate,
    rank,
    agencyId: 'nichols-fd',
    roles,
  }),
);

export const DEMO_MEMBER_BY_ID: ReadonlyMap<string, Member> = new Map(
  DEMO_MEMBERS.map((member) => [member.memberId, member]),
);

/** Members who respond to calls today: active or probationary, not on leave or retired. */
export const DEMO_RESPONDING_MEMBER_IDS: readonly string[] = DEMO_MEMBERS.filter(
  (m) => m.status === 'ACTIVE' || m.status === 'PROBATIONARY',
).map((m) => m.memberId);

/** Interior-qualified firefighters and officers (no fire police, probies, or admin-only). */
export const DEMO_INTERIOR_MEMBER_IDS: readonly string[] = DEMO_MEMBERS.filter(
  (m) =>
    m.status === 'ACTIVE' &&
    !['Fire Police', 'Administrative Member'].includes(m.rank) &&
    m.memberId !== 'm-11',
).map((m) => m.memberId);

/** Driver/operators: engineers plus the officers who drive. */
export const DEMO_DRIVER_MEMBER_IDS: readonly string[] = [
  'm-12',
  'm-13',
  'm-14',
  'm-9',
  'm-3',
  'm-21',
  'm-23',
];

export function demoMemberName(memberId: string): string {
  const member = DEMO_MEMBER_BY_ID.get(memberId);
  return member ? `${member.firstName} ${member.lastName}` : memberId;
}

export function demoMemberSortName(memberId: string): string {
  const member = DEMO_MEMBER_BY_ID.get(memberId);
  return member ? `${member.lastName}, ${member.firstName}` : memberId;
}

/** The fleet, as named everywhere in the demo (apparatus fixtures own the full records). */
export const DEMO_FLEET = [
  { apparatusId: 'a-1', unitId: 'Rescue 300', type: 'Rescue' },
  { apparatusId: 'a-2', unitId: 'Engine 301', type: 'Engine' },
  { apparatusId: 'a-3', unitId: 'Truck 304', type: 'Ladder' },
  { apparatusId: 'a-4', unitId: 'Engine 305', type: 'Engine' },
  { apparatusId: 'a-5', unitId: 'Squad 309', type: 'Squad' },
  { apparatusId: 'a-6', unitId: 'Utility 302', type: 'Utility' },
  { apparatusId: 'a-7', unitId: 'Brush 307', type: 'Brush' },
] as const;

export const DEMO_STATION = { stationId: 'STATION-1', name: 'Station 1 — Nichols' } as const;
