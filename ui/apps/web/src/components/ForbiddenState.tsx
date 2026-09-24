import type { ProblemDetails } from '../lib/apiClient';
import { Ban } from './ui/icons';
import styles from './StateScreen.module.css';

/** Fixed, generic 403 copy. The server's `detail` (and Cedar policy/action names it can
 * contain) is intentionally not rendered — see security finding on PR #93 review round 2:
 * an authenticated user could otherwise probe internal authorization details via 403 bodies.
 * `traceId` stays out of the DOM too; both remain available to telemetry/console logging. */
const GENERIC_FORBIDDEN_MESSAGE = 'You do not have access to this page.';

export function ForbiddenState({
  problem,
  embedded = false,
  headingLevel = 'h1',
}: {
  problem?: Pick<ProblemDetails, 'detail' | 'traceId' | 'title'>;
  /** When true, render as an alert region (safe inside an existing <main>). */
  embedded?: boolean;
  /** Heading level for the title. Pass 'h2' when embedding inside a page that already
   * renders its own <h1>, so the document never ends up with two level-1 headings. */
  headingLevel?: 'h1' | 'h2';
}) {
  const Heading = headingLevel;
  const body = (
    <div className={styles.wrapper}>
      <Ban size={28} className={styles.icon} aria-hidden="true" />
      <Heading className={styles.title}>{problem?.title ?? 'Forbidden'}</Heading>
      <div role="alert">
        <p className={styles.message}>{GENERIC_FORBIDDEN_MESSAGE}</p>
      </div>
    </div>
  );

  if (embedded) return body;
  return <main id="main-content">{body}</main>;
}
