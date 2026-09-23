import type { ProblemDetails } from '../lib/apiClient';

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
    <>
      <Heading style={{ fontSize: 'var(--boxalarm-font-size-xl)', margin: 0 }}>
        {problem?.title ?? 'Forbidden'}
      </Heading>
      <div role="alert">
        <p style={{ marginTop: 'var(--boxalarm-spacing-md)' }}>{GENERIC_FORBIDDEN_MESSAGE}</p>
      </div>
    </>
  );

  if (embedded) {
    return <section style={{ padding: 'var(--boxalarm-spacing-lg)' }}>{body}</section>;
  }

  return (
    <main id="main-content" style={{ padding: 'var(--boxalarm-spacing-lg)' }}>
      {body}
    </main>
  );
}
