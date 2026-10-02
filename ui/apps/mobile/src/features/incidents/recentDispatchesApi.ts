import { apiRequest, type AuthTokenSource } from '../../lib/apiClient';

/** GET incidents/dispatches (incident-service listRecentDispatches.ts): one dispatch to report on. */
export interface ReportableDispatch {
  dispatchId: string;
  incidentType: string;
  address: string;
  /** Epoch seconds. */
  dispatchedAt: number;
  /** The report already started from it; null when there is none yet. */
  report: { incidentId: string; status: string } | null;
  /** A CAD dispatch that couldn't be parsed: its address is a placeholder. */
  verifyRequired?: true;
  /** The start of its dispatch text, sent with verifyRequired. */
  textExcerpt?: string;
}

export interface ReportableDispatchPage {
  recentWindowHours: number;
  dispatches: ReportableDispatch[];
  nextCursor: string | null;
}

/** Without a cursor: every dispatch of the last 72 hours. With one: the next older page. */
export async function listRecentDispatches(
  tokens: AuthTokenSource,
  apiBaseUrl: string,
  cursor?: string,
): Promise<ReportableDispatchPage> {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  const response = await apiRequest(`incidents/dispatches${qs}`, tokens, { apiBaseUrl });
  return (await response.json()) as ReportableDispatchPage;
}

/** POST incidents { dispatchId }: a draft report pre-filled from the dispatch. */
export async function startReportFromDispatch(
  tokens: AuthTokenSource,
  apiBaseUrl: string,
  dispatchId: string,
): Promise<{ incidentId: string }> {
  const response = await apiRequest('incidents', tokens, {
    apiBaseUrl,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dispatchId }),
  });
  return (await response.json()) as { incidentId: string };
}
