import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import type { AuthTokenSource } from '../../lib/apiClient';
import { ApiError } from '../../lib/apiClient';
import { Card, Skeleton } from '../../components/ui';
import { getApparatus, getCompliance, listApparatus, listOpenDefects } from './api';
import type { Apparatus, OpenDefectSummary } from './types';

const SEVERITY_WORD: Record<OpenDefectSummary['severity'], string> = {
  MINOR: 'Note',
  MAJOR: 'Affects service',
  OUT_OF_SERVICE: 'Out of service now',
};
const SEVERITY_RANK: Record<OpenDefectSummary['severity'], number> = {
  MINOR: 0,
  MAJOR: 1,
  OUT_OF_SERVICE: 2,
};

function unitLink(unitId: string) {
  return <Link to={`/apparatus/${encodeURIComponent(unitId)}`}>{unitId}</Link>;
}

interface DefectEntry {
  readonly unitId: string;
  readonly defect: OpenDefectSummary;
}

interface OpenDefectsResult {
  readonly entries: DefectEntry[];
  /** Fallback mode only: units whose detail could not be read. */
  readonly failedUnits: number;
}

/**
 * One request for the whole department (owed review minor 8). An older server without the
 * route answers 404; only then fall back to the previous shape — the unit list, then each
 * unit's detail — keeping the partial-failure count the card already reports.
 */
async function fetchOpenDefects(auth: AuthTokenSource): Promise<OpenDefectsResult> {
  try {
    const defects = await listOpenDefects(auth);
    return {
      entries: defects.map((defect) => ({ unitId: defect.unitId, defect })),
      failedUnits: 0,
    };
  } catch (error) {
    if (!(error instanceof ApiError) || error.problem.status !== 404) throw error;
    const units = await listApparatus(auth);
    const settled = await Promise.allSettled(
      units.map(async (unit) => ({ unit, detail: await getApparatus(auth, unit.unitId) })),
    );
    const entries: DefectEntry[] = [];
    let failedUnits = 0;
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        entries.push(
          ...result.value.detail.openDefects.map((defect) => ({
            unitId: result.value.unit.unitId,
            defect,
          })),
        );
      } else {
        failedUnits += 1;
      }
    }
    return { entries, failedUnits };
  }
}

/**
 * The apparatus officer's to-do list (review R4): units with no check today (the compliance
 * report for today, which expects one per day), the department's open defects (one
 * GET apparatus/defects request; per-unit details only as the 404 fallback for an older
 * server), and units out of service. Each list says when it couldn't load instead of showing
 * a clean "nothing to do".
 */
export function ApparatusToDo() {
  const auth = useAuth();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const from = Math.floor(startOfToday.getTime() / 1000);
  const to = Math.floor(Date.now() / 1000);

  const apparatusQuery = useQuery({ queryKey: ['apparatus'], queryFn: () => listApparatus(auth) });
  const complianceQuery = useQuery({
    queryKey: ['apparatus', 'compliance', 'today', from],
    queryFn: () => getCompliance(auth, from, to),
  });
  const units: Apparatus[] = apparatusQuery.data ?? [];
  const defectsQuery = useQuery({
    queryKey: ['apparatus', 'defects', 'open'],
    queryFn: () => fetchOpenDefects(auth),
  });

  const checksDue = (complianceQuery.data ?? []).filter((entry) => entry.actualChecks === 0);
  const defects = [...(defectsQuery.data?.entries ?? [])];
  defects.sort(
    (a, b) =>
      SEVERITY_RANK[b.defect.severity] - SEVERITY_RANK[a.defect.severity] ||
      a.defect.reportedAt - b.defect.reportedAt,
  );
  const defectsFailed = defectsQuery.data?.failedUnits ?? 0;
  const defectsLoading = defectsQuery.isLoading;
  const outOfService = units.filter((unit) => unit.status === 'OUT_OF_SERVICE');

  return (
    <Card title="Apparatus to-do">
      <h3 style={{ margin: 0 }}>Checks due today</h3>
      {complianceQuery.isLoading ? (
        <Skeleton lines={2} />
      ) : complianceQuery.error ? (
        <p role="status">Couldn&rsquo;t load today&rsquo;s checks. This is not an empty list.</p>
      ) : checksDue.length === 0 ? (
        <p>Every unit has been checked today.</p>
      ) : (
        <ul aria-label="Units not checked today">
          {checksDue.map((entry) => (
            <li key={entry.unitId}>{unitLink(entry.unitId)} — not checked yet today</li>
          ))}
        </ul>
      )}

      <h3 style={{ margin: 0 }}>Open defects</h3>
      {defectsLoading ? (
        <Skeleton lines={2} />
      ) : defectsQuery.error ? (
        <p role="status">Couldn&rsquo;t load open defects. This is not an empty list.</p>
      ) : (
        <>
          {defects.length === 0 && defectsFailed === 0 ? <p>No open defects.</p> : null}
          {defects.length > 0 ? (
            <ul aria-label="Open defects">
              {defects.map(({ unitId, defect }) => (
                <li key={defect.defectId}>
                  {unitLink(unitId)} — {SEVERITY_WORD[defect.severity]}: {defect.description}
                </li>
              ))}
            </ul>
          ) : null}
          {defectsFailed > 0 ? (
            <p role="status">
              Defects for {defectsFailed} {defectsFailed === 1 ? 'unit' : 'units'} couldn&rsquo;t
              load.
            </p>
          ) : null}
        </>
      )}

      {outOfService.length > 0 ? (
        <>
          <h3 style={{ margin: 0 }}>Out of service</h3>
          <ul aria-label="Units out of service">
            {outOfService.map((unit) => (
              <li key={unit.unitId}>
                {unitLink(unit.unitId)}
                {unit.outOfService?.reason ? ` — ${unit.outOfService.reason}` : ''}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Card>
  );
}
