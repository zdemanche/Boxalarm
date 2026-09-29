import { Card } from '../../components/ui';
import type { NearestHydrant, PrePlanEnrichment, UtilityShutoff } from './types';

/** "H-014 · 90 m · 6-inch · 1000 gpm (class A)" - one glanceable line per hydrant. */
function describeHydrant(hydrant: NearestHydrant): string {
  const flow =
    hydrant.flowRatingGpm !== undefined
      ? `${hydrant.flowRatingGpm} gpm${hydrant.flowClass ? ` (class ${hydrant.flowClass})` : ''}`
      : hydrant.flowClass
        ? `class ${hydrant.flowClass}`
        : undefined;
  return [
    hydrant.hydrantId,
    hydrant.distanceMeters !== undefined ? `${hydrant.distanceMeters} m` : undefined,
    hydrant.size,
    flow,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
}

function withUnit(address: string, unit: string | null | undefined): string {
  // Skip when the address already names the unit ("40 Oak Ave Apt 2").
  const words = address.toUpperCase().split(/[\s,#.]+/);
  return unit && !words.slice(1).includes(unit.toUpperCase())
    ? `${address} (unit ${unit})`
    : address;
}

/**
 * What the pre-plan was matched on, in words. `warning` notices are guesses the crew must
 * check - they lead with "VERIFY ADDRESS" so the meaning never rests on colour alone.
 */
export function matchNotice(prePlan: PrePlanEnrichment): { text: string; warning: boolean } | null {
  const address = prePlan.matchedAddress;
  switch (prePlan.matchType) {
    case 'ADDRESS':
      return address ? { text: `Pre-plan for ${address}`, warning: false } : null;
    case 'ADDRESS_BUILDING':
      return {
        text: `Building-level pre-plan for ${address ?? 'this address'} (no plan for the dispatched unit)`,
        warning: false,
      };
    case 'UNIT_MISMATCH':
      return {
        text: `VERIFY ADDRESS: this pre-plan is for ${withUnit(address ?? 'another unit', prePlan.unit)}, a different unit than dispatched.`,
        warning: true,
      };
    case 'NEARBY':
      return {
        text: `VERIFY ADDRESS: nearby pre-plan for ${address ?? 'another address'}${prePlan.distanceMeters !== undefined ? `, ${prePlan.distanceMeters} m from the dispatch location` : ''}.`,
        warning: true,
      };
    case 'CANDIDATES':
      return {
        text: `VERIFY ADDRESS: ${prePlan.candidates?.length ?? 'Several'} pre-plans match this address. Confirm which one applies.`,
        warning: true,
      };
    default:
      return null;
  }
}

const noticeStyle = (warning: boolean) =>
  warning
    ? {
        borderLeft: '4px solid var(--bx-status-warning)',
        paddingLeft: 8,
        fontWeight: 700,
      }
    : { fontWeight: 600 };

function HazardList({ hazards }: { hazards: readonly string[] }) {
  if (hazards.length === 0) return null;
  return (
    <div>
      <h3 style={{ fontSize: 15, fontWeight: 600 }}>Hazards</h3>
      <ul>
        {hazards.map((hazard) => (
          <li key={hazard} style={{ color: 'var(--bx-status-danger)' }}>
            {hazard}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ShutoffList({ shutoffs }: { shutoffs: readonly UtilityShutoff[] }) {
  if (shutoffs.length === 0) return null;
  return (
    <div>
      <h3 style={{ fontSize: 15, fontWeight: 600 }}>Utility shutoffs</h3>
      <ul>
        {shutoffs.map((shutoff) => (
          <li key={`${shutoff.utility}-${shutoff.location}`}>
            {shutoff.utility}: {shutoff.location}
          </li>
        ))}
      </ul>
    </div>
  );
}

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

  const notice = matchNotice(prePlan);

  return (
    <Card title="Pre-plan">
      {notice ? (
        <p role={notice.warning ? 'note' : undefined} style={noticeStyle(notice.warning)}>
          {notice.text}
        </p>
      ) : null}

      {prePlan.matchType === 'CANDIDATES' ? (
        <ul aria-label="Matching pre-plans">
          {(prePlan.candidates ?? []).map((candidate) => (
            <li key={candidate.occupancyId}>
              <h3 style={{ fontSize: 15, fontWeight: 700 }}>
                {withUnit(candidate.matchedAddress, candidate.unit)}
                {candidate.distanceMeters !== undefined ? ` · ${candidate.distanceMeters} m` : ''}
              </h3>
              {candidate.summary ? <p>{candidate.summary}</p> : null}
              <HazardList hazards={candidate.hazards} />
              <ShutoffList shutoffs={candidate.utilityShutoffs} />
            </li>
          ))}
        </ul>
      ) : null}

      {prePlan.summary ? <p>{prePlan.summary}</p> : null}
      <HazardList hazards={prePlan.hazards} />
      <ShutoffList shutoffs={prePlan.utilityShutoffs} />

      {prePlan.nearestHydrants.length > 0 ? (
        <div>
          <h3 style={{ fontSize: 15, fontWeight: 600 }}>Nearest hydrants</h3>
          <ul>
            {prePlan.nearestHydrants.map((hydrant) => (
              <li key={hydrant.hydrantId}>{describeHydrant(hydrant)}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}
