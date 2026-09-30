import { useQueries, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { Card, Skeleton } from '../../components/ui';
import { getApparatus, getCompliance, listApparatus } from './api';
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

/**
 * The apparatus officer's to-do list (review R4), built from data the apparatus API already
 * serves: units with no check today (the compliance report for today, which expects one per
 * day), open defects per unit (each unit's detail), and units out of service. Each list says
 * when it couldn't load instead of showing a clean "nothing to do".
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
  const detailQueries = useQueries({
    queries: units.map((unit) => ({
      queryKey: ['apparatus', unit.unitId],
      queryFn: () => getApparatus(auth, unit.unitId),
    })),
  });

  const checksDue = (complianceQuery.data ?? []).filter((entry) => entry.actualChecks === 0);
  const defects = units.flatMap((unit, index) =>
    (detailQueries[index]?.data?.openDefects ?? []).map((defect) => ({ unit, defect })),
  );
  defects.sort(
    (a, b) =>
      SEVERITY_RANK[b.defect.severity] - SEVERITY_RANK[a.defect.severity] ||
      a.defect.reportedAt - b.defect.reportedAt,
  );
  const defectsFailed = detailQueries.filter((q) => q.error).length;
  const defectsLoading = apparatusQuery.isLoading || detailQueries.some((q) => q.isLoading);
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
      ) : apparatusQuery.error ? (
        <p role="status">Couldn&rsquo;t load the apparatus list. This is not an empty list.</p>
      ) : (
        <>
          {defects.length === 0 && defectsFailed === 0 ? <p>No open defects.</p> : null}
          {defects.length > 0 ? (
            <ul aria-label="Open defects">
              {defects.map(({ unit, defect }) => (
                <li key={defect.defectId}>
                  {unitLink(unit.unitId)} — {SEVERITY_WORD[defect.severity]}: {defect.description}
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
