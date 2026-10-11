import { Link, useInRouterContext, useLocation } from 'react-router-dom';
import { ROLE_PRIORITY, type Role } from '../auth/roles';
import type { ProblemDetails } from '../lib/apiClient';
import { APP_ROUTES, type AppRoute } from '../routing/routeTable';
import { buttonClassName } from './ui/Button';
import { ShieldAlert } from './ui/icons';
import styles from './StateScreen.module.css';

/** Fixed, generic 403 copy. The server's `detail` (and Cedar policy/action names it can
 * contain) is intentionally not rendered — see security finding on PR #93 review round 2:
 * an authenticated user could otherwise probe internal authorization details via 403 bodies.
 * `traceId` stays out of the DOM too; both remain available to telemetry/console logging. */
const GENERIC_FORBIDDEN_MESSAGE = 'You do not have access to this page.';

/** RequireRole marks its synthetic problem with this traceId: the denial is the route table's
 * role list, so that list is exactly who can open the page. An API 403 on a page the user can
 * open says nothing about who could, so it never names roles. */
const ROUTE_GUARD_TRACE_ID = 'route-guard';

const ASK_FOR_ACCESS = 'Ask the chief or the department administrator to change your role.';

/** design.md §4.7: the copy names the role, not an abstract permission. */
const ROLE_NOUN: Record<Role, string> = {
  CHIEF: 'chief',
  ADMIN: 'administrator',
  OFFICER: 'officer',
  TRAINING: 'training officer',
  APPARATUS: 'apparatus officer',
  MEMBER: 'member',
};

function joinNouns(nouns: string[]): string {
  if (nouns.length <= 1) return nouns.join('');
  return `${nouns.slice(0, -1).join(', ')} and ${nouns[nouns.length - 1]}`;
}

/** "Only the chief and administrator can open the CAD sources page." */
function whoCanOpen(roles: readonly Role[], pageLabel?: string): string {
  const nouns = ROLE_PRIORITY.filter((role) => roles.includes(role)).map((r) => ROLE_NOUN[r]);
  return `Only the ${joinNouns(nouns)} can open ${pageLabel ? `the ${pageLabel} page` : 'this page'}.`;
}

/** The route-table entry a pathname resolves to — same first-match rule as canAccessPath. */
function routeFor(pathname: string): AppRoute | undefined {
  const parts = pathname.split('/').filter(Boolean);
  return APP_ROUTES.find((route) => {
    const pattern = route.path.split('/').filter(Boolean);
    return (
      pattern.length === parts.length &&
      pattern.every((segment, i) => segment.startsWith(':') || segment === parts[i])
    );
  });
}

/** Who can open the page, and the way back. Needs the router (useLocation, Link), so it only
 * renders inside one; unit tests that mount the state bare still get the message. */
function RouteAccess({
  allowedRoles,
  fromRouteGuard,
}: {
  allowedRoles?: readonly Role[];
  fromRouteGuard: boolean;
}) {
  const { pathname } = useLocation();
  const route = routeFor(pathname);
  const roles = allowedRoles ?? (fromRouteGuard ? route?.roles : undefined);

  return (
    <>
      <p className={styles.detail}>
        {roles && roles.length > 0 ? `${whoCanOpen(roles, route?.label)} ` : null}
        {ASK_FOR_ACCESS}
      </p>
      <div className={styles.actions}>
        <Link to="/" className={buttonClassName({ variant: 'secondary' })}>
          Back to dashboard
        </Link>
      </div>
    </>
  );
}

export function ForbiddenState({
  problem,
  embedded = false,
  headingLevel = 'h1',
  allowedRoles,
}: {
  problem?: Pick<ProblemDetails, 'detail' | 'traceId' | 'title'>;
  /** When true, render as an alert region (safe inside an existing <main>). */
  embedded?: boolean;
  /** Heading level for the title. Pass 'h2' when embedding inside a page that already
   * renders its own <h1>, so the document never ends up with two level-1 headings. */
  headingLevel?: 'h1' | 'h2';
  /** The roles that can open this page, when the caller knows them. A full-page route-guard
   * denial works them out from the route table on its own. */
  allowedRoles?: readonly Role[];
}) {
  const Heading = headingLevel;
  const inRouter = useInRouterContext();
  const title = problem?.title ?? 'Forbidden';
  const message = (
    <div role="alert">
      <p className={styles.message}>{GENERIC_FORBIDDEN_MESSAGE}</p>
    </div>
  );

  if (embedded) {
    return (
      <div className={styles.inline}>
        <span className={styles.badge}>
          <ShieldAlert size={18} aria-hidden="true" />
        </span>
        <div className={styles.inlineBody}>
          <Heading className={styles.title}>{title}</Heading>
          {message}
          <p className={styles.detail}>
            {allowedRoles && allowedRoles.length > 0 ? `${whoCanOpen(allowedRoles)} ` : null}
            {ASK_FOR_ACCESS}
          </p>
        </div>
      </div>
    );
  }

  return (
    <main id="main-content" className={styles.page}>
      <div className={styles.card}>
        <span className={styles.badge}>
          <ShieldAlert size={24} aria-hidden="true" />
        </span>
        <Heading className={styles.title}>{title}</Heading>
        {message}
        {inRouter ? (
          <RouteAccess
            allowedRoles={allowedRoles}
            fromRouteGuard={problem?.traceId === ROUTE_GUARD_TRACE_ID}
          />
        ) : (
          <p className={styles.detail}>
            {allowedRoles && allowedRoles.length > 0 ? `${whoCanOpen(allowedRoles)} ` : null}
            {ASK_FOR_ACCESS}
          </p>
        )}
      </div>
    </main>
  );
}
