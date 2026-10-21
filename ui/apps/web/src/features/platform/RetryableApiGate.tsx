import { ApiError } from '../../lib/apiClient';
import { ApiErrorState } from '../../components/ApiErrorState';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';

export function RetryableApiGate({
  error,
  onRetry,
  children,
}: {
  error: unknown;
  onRetry: () => void;
  children: React.ReactNode;
}) {
  if (error && !(error instanceof ApiError && error.problem.status === 403)) {
    return <ApiErrorState embedded headingLevel="h2" onRetry={onRetry} />;
  }
  return (
    <ApiForbiddenGate error={error} embedded>
      {children}
    </ApiForbiddenGate>
  );
}
