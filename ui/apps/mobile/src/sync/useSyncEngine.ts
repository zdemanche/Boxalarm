import { useEffect, useRef } from 'react';
import Config from 'react-native-config';
import { useOptionalAuth } from '../auth/AuthContext';
import * as syncManager from './syncManager';

/**
 * Points the offline outbox at the API for as long as the app is signed in. Mounted once at the
 * app root so work queued in an earlier session (a truck check, a field capture, attendance)
 * drains on launch and on reconnect regardless of which tab the member opens first - previously
 * only the Checks screens configured it, so nothing drained until someone opened Checks.
 */
export function useSyncEngine(): void {
  const auth = useOptionalAuth();
  const apiBaseUrl = Config.API_BASE_URL;
  const isAuthenticated = auth?.isAuthenticated ?? false;
  // Reconfigure when the member changes, so queued work is always stamped with and sent for the
  // member who is actually signed in (R2-M3).
  const memberId = auth?.memberId ?? null;
  // While the stored session is still being read there is no answer yet to "who is signed in":
  // configuring null then would stop a headless answer's run mid-send (m2).
  const isLoading = auth?.isLoading ?? false;
  // The token source is read through a ref so a token refresh never re-runs configure().
  const authRef = useRef(auth);
  authRef.current = auth;

  useEffect(() => {
    if (isLoading) return;
    // The session is passed even without an API base URL (dev builds) so the outbox knows whose
    // work it holds; nothing drains without both (syncManager.drain).
    const tokens = isAuthenticated ? (authRef.current ?? null) : null;
    syncManager.configure(tokens, apiBaseUrl || null);
  }, [apiBaseUrl, isAuthenticated, isLoading, memberId]);
}
