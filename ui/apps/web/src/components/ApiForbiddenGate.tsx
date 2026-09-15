import { ApiError } from '../lib/apiClient';
import { ForbiddenState } from './ForbiddenState';

/** Render ForbiddenState for API 403 problem+json; otherwise rethrow / render children. */
export function ApiForbiddenGate({
  error,
  children,
  embedded = false,
}: {
  error: unknown;
  children: React.ReactNode;
  /** Pass true when already inside a page <main> to avoid nested landmarks. */
  embedded?: boolean;
}) {
  if (error instanceof ApiError && error.problem.status === 403) {
    return <ForbiddenState problem={error.problem} embedded={embedded} />;
  }
  if (error) throw error;
  return children;
}
