/**
 * Fail-closed HTTP API Lambda authorizer stub.
 * Real handler lives in boxalarm-backend platform-service/authorizer.
 */
export function handler(event: {
  headers?: Record<string, string | undefined>;
}): Promise<{ isAuthorized: boolean }>;
