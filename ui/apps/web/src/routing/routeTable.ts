import type { Role } from '../auth/roles';

/** Sidebar groups, docs/design.md §3.4 (Overview · Response · People · Apparatus · Admin), plus
 * Prevention for the F6 occupancy / hydrant / inspection routes, which the §3.4 table predates. */
export type NavGroup = 'Overview' | 'Response' | 'People' | 'Apparatus' | 'Prevention' | 'Admin';

export const NAV_GROUP_ORDER: readonly NavGroup[] = [
  'Overview',
  'Response',
  'People',
  'Apparatus',
  'Prevention',
  'Admin',
];

export interface AppRoute {
  path: string;
  /** Path used for nav links (no params). */
  navPath: string;
  label: string;
  roles: readonly Role[];
  /** When true, shown in PrimaryNav. Param routes use a parent list entry. */
  showInNav: boolean;
  /** Sidebar group the nav entry sits under. */
  group: NavGroup;
}

/**
 * Architecture §7.1 web SPA route table — single source for PrimaryNav + guards.
 * Sibling issues fill page bodies; this ticket only wires access.
 */
export const APP_ROUTES: readonly AppRoute[] = [
  {
    path: '/',
    navPath: '/',
    label: 'Dashboard',
    roles: ['CHIEF', 'OFFICER'],
    group: 'Overview',
    showInNav: true,
  },
  {
    path: '/alerts/roster',
    navPath: '/alerts/roster',
    label: 'Live roster',
    roles: ['OFFICER', 'CHIEF'],
    group: 'Response',
    showInNav: true,
  },
  {
    path: '/alerts/diagnostics',
    navPath: '/alerts/diagnostics',
    label: 'Alert diagnostics',
    roles: ['OFFICER', 'CHIEF', 'ADMIN'],
    group: 'Response',
    showInNav: true,
  },
  {
    path: '/incidents',
    navPath: '/incidents',
    label: 'Incidents',
    // ADMIN: creates reports (createIncident) and is one of the two roles that may
    // unlock a reviewed one, so it needs the pages.
    roles: ['OFFICER', 'CHIEF', 'ADMIN'],
    group: 'Response',
    showInNav: true,
  },
  {
    path: '/incidents/:id',
    navPath: '/incidents',
    label: 'Incident detail',
    // ADMIN: creates reports (createIncident) and is one of the two roles that may
    // unlock a reviewed one, so it needs the pages.
    roles: ['OFFICER', 'CHIEF', 'ADMIN'],
    group: 'Response',
    showInNav: false,
  },
  {
    path: '/personnel',
    navPath: '/personnel',
    // docs/design.md §3.2: "Member", never "personnel". The URL keeps /personnel so existing
    // links and bookmarks still resolve.
    label: 'Members',
    roles: ['OFFICER', 'TRAINING', 'ADMIN', 'CHIEF'],
    group: 'People',
    showInNav: true,
  },
  {
    path: '/personnel/:id',
    navPath: '/personnel',
    label: 'Member detail',
    roles: ['OFFICER', 'TRAINING', 'ADMIN', 'CHIEF'],
    group: 'People',
    showInNav: false,
  },
  {
    path: '/certifications',
    navPath: '/certifications',
    label: 'Certifications',
    // CHIEF: ViewCertifications is every-role and ViewExpiringCertifications/CreateCertification
    // are the officer tier, which includes CHIEF (cedar-policies.ts). The page keeps its write
    // controls for canManageTraining roles, so the chief reads.
    roles: ['TRAINING', 'ADMIN', 'CHIEF'],
    group: 'People',
    showInNav: true,
  },
  {
    path: '/training/events',
    navPath: '/training/events',
    label: 'Training events',
    // CHIEF: listing events is every-role and CreateTrainingEvent is the officer tier.
    roles: ['TRAINING', 'ADMIN', 'CHIEF'],
    group: 'People',
    showInNav: true,
  },
  {
    // GET training/hours roster view is ViewRosterTrainingHours — the officer tier
    // (cedar-policies.ts OFFICER_TIER_GROUPS: OFFICER, TRAINING, CHIEF, ADMIN).
    path: '/training/hours',
    navPath: '/training/hours',
    label: 'Training hours',
    roles: ['TRAINING', 'ADMIN', 'OFFICER', 'CHIEF'],
    group: 'People',
    showInNav: true,
  },
  {
    path: '/apparatus',
    navPath: '/apparatus',
    label: 'Apparatus',
    // OFFICER/ADMIN: the apparatus list and detail read on the department-scoped authorizer with
    // no Cedar tier, and every tab the detail page reads is every-role or the apparatus-officer
    // tier (APPARATUS, OFFICER, CHIEF, ADMIN). The officer decides whether a rig rolls, so they
    // need to see what is out of service and why.
    roles: ['APPARATUS', 'OFFICER', 'ADMIN', 'CHIEF'],
    group: 'Apparatus',
    showInNav: true,
  },
  {
    path: '/apparatus/compliance',
    navPath: '/apparatus/compliance',
    label: 'Apparatus compliance',
    roles: ['ADMIN', 'CHIEF'],
    group: 'Apparatus',
    showInNav: true,
  },
  {
    path: '/apparatus/:id',
    navPath: '/apparatus',
    label: 'Apparatus detail',
    roles: ['APPARATUS', 'OFFICER', 'ADMIN', 'CHIEF'],
    group: 'Apparatus',
    showInNav: false,
  },
  {
    path: '/inventory',
    navPath: '/inventory',
    label: 'Inventory',
    // OFFICER: inventory reads are every-role and its writes are OFFICER/CHIEF/ADMIN.
    roles: ['ADMIN', 'APPARATUS', 'OFFICER', 'CHIEF'],
    group: 'Apparatus',
    showInNav: true,
  },
  {
    path: '/inventory/:assetId',
    navPath: '/inventory',
    label: 'Equipment detail',
    roles: ['ADMIN', 'APPARATUS', 'OFFICER', 'CHIEF'],
    group: 'Apparatus',
    showInNav: false,
  },
  {
    path: '/inspections/occupancies',
    navPath: '/inspections/occupancies',
    label: 'Occupancies',
    roles: ['OFFICER', 'ADMIN', 'CHIEF'],
    group: 'Prevention',
    showInNav: true,
  },
  {
    path: '/inspections/occupancies/:id',
    navPath: '/inspections/occupancies',
    label: 'Occupancy detail',
    roles: ['OFFICER', 'ADMIN', 'CHIEF'],
    group: 'Prevention',
    showInNav: false,
  },
  {
    path: '/inspections/hydrants',
    navPath: '/inspections/hydrants',
    label: 'Hydrants',
    roles: ['OFFICER', 'ADMIN', 'CHIEF'],
    group: 'Prevention',
    showInNav: true,
  },
  {
    path: '/inspections',
    navPath: '/inspections',
    label: 'Inspections',
    roles: ['OFFICER', 'ADMIN', 'CHIEF'],
    group: 'Prevention',
    showInNav: true,
  },
  {
    path: '/inspections/map',
    navPath: '/inspections/map',
    label: 'Inspections map',
    roles: ['OFFICER', 'ADMIN', 'CHIEF'],
    group: 'Prevention',
    showInNav: true,
  },
  {
    path: '/schedule',
    navPath: '/schedule',
    label: 'Schedule',
    // CHIEF: shift writes are OFFICER/ADMIN/CHIEF (personnel-service shifts OFFICER_ROLES) and
    // ListPendingShiftSwaps/ApproveShiftSwap are the officer tier, which includes CHIEF.
    roles: ['OFFICER', 'ADMIN', 'CHIEF'],
    group: 'People',
    showInNav: true,
  },
  {
    path: '/reporting',
    navPath: '/reporting',
    label: 'Reporting',
    roles: ['CHIEF', 'ADMIN', 'TRAINING'],
    group: 'Admin',
    showInNav: true,
  },
  {
    path: '/settings',
    navPath: '/settings',
    label: 'Settings',
    roles: ['ADMIN'],
    group: 'Admin',
    showInNav: true,
  },
  {
    path: '/settings/losap',
    navPath: '/settings',
    label: 'LOSAP settings',
    roles: ['ADMIN'],
    group: 'Admin',
    showInNav: false,
  },
  {
    // Every role's own inbox. Reached from the top-bar bell, not PrimaryNav, so MEMBER still
    // has no domain nav routes.
    path: '/notifications',
    navPath: '/notifications',
    label: 'Notifications',
    roles: ['MEMBER', 'OFFICER', 'TRAINING', 'APPARATUS', 'ADMIN', 'CHIEF'],
    group: 'Overview',
    showInNav: false,
  },
  {
    path: '/audit-log',
    navPath: '/audit-log',
    label: 'Audit log',
    roles: ['ADMIN', 'CHIEF'],
    group: 'Admin',
    showInNav: true,
  },
] as const;

export function routesForRoles(userRoles: readonly Role[]): AppRoute[] {
  return APP_ROUTES.filter(
    (route) => route.showInNav && route.roles.some((r) => userRoles.includes(r)),
  );
}

export function canAccessPath(pathname: string, userRoles: readonly Role[]): boolean {
  const match = APP_ROUTES.find((route) => pathMatches(route.path, pathname));
  if (!match) return false;
  return match.roles.some((r) => userRoles.includes(r));
}

/** The nav entry a pathname belongs to: `/apparatus/compliance` -> `/apparatus/compliance`,
 * `/apparatus/E1` -> `/apparatus`. Used for the nav's active state, so a nested nav route
 * doesn't also light up its parent (PR #321 review m4). */
export function activeNavPathFor(pathname: string): string | null {
  return APP_ROUTES.find((route) => pathMatches(route.path, pathname))?.navPath ?? null;
}

export interface NavSection {
  group: NavGroup;
  routes: AppRoute[];
}

/** routesForRoles, bucketed into the sidebar groups in NAV_GROUP_ORDER; empty groups dropped. */
export function navSectionsForRoles(userRoles: readonly Role[]): NavSection[] {
  const routes = routesForRoles(userRoles);
  return NAV_GROUP_ORDER.map((group) => ({
    group,
    routes: routes.filter((route) => route.group === group),
  })).filter((section) => section.routes.length > 0);
}

export function firstGrantedNavPath(userRoles: readonly Role[]): string | null {
  const routes = routesForRoles(userRoles);
  return routes[0]?.navPath ?? null;
}

function pathMatches(pattern: string, pathname: string): boolean {
  if (pattern === '/') return pathname === '/';
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return false;
  return patternParts.every((part, i) => part.startsWith(':') || part === pathParts[i]);
}
