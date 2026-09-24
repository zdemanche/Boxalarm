import { Card } from '../../components/ui';
import type { PrePlanEnrichment } from './types';

// E1-S17-UI / E5-S8-UI: same alerting-route enrichment as mobile (N1.5 - never /inspections/*).
export function PrePlanPanel({ prePlan }: { prePlan: PrePlanEnrichment | null | undefined }) {
  if (prePlan === undefined) return null;

  if (prePlan === null) {
    return (
      <Card title="Pre-plan">
        <p>No pre-plan on file for this address.</p>
      </Card>
    );
  }

  return (
    <Card title="Pre-plan">
      {prePlan.summary ? <p>{prePlan.summary}</p> : null}

      {prePlan.hazards.length > 0 ? (
        <div>
          <h3 style={{ fontSize: 15, fontWeight: 600 }}>Hazards</h3>
          <ul>
            {prePlan.hazards.map((hazard) => (
              <li key={hazard} style={{ color: 'var(--bx-status-danger)' }}>
                {hazard}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {prePlan.utilityShutoffs.length > 0 ? (
        <div>
          <h3 style={{ fontSize: 15, fontWeight: 600 }}>Utility shutoffs</h3>
          <ul>
            {prePlan.utilityShutoffs.map((shutoff) => (
              <li key={`${shutoff.utility}-${shutoff.location}`}>
                {shutoff.utility}: {shutoff.location}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {prePlan.nearestHydrants.length > 0 ? (
        <div>
          <h3 style={{ fontSize: 15, fontWeight: 600 }}>Nearest hydrants</h3>
          <ul>
            {prePlan.nearestHydrants.map((hydrant) => (
              <li key={hydrant.hydrantId}>
                {hydrant.hydrantId}
                {hydrant.size ? ` · ${hydrant.size}` : ''}
                {hydrant.flowRatingGpm ? ` · ${hydrant.flowRatingGpm} gpm` : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}
