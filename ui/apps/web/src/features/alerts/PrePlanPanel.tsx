import { Card } from '../../components/ui';
import type { NearestHydrant, PrePlanEnrichment, UtilityShutoff } from './types';

/** Listed only when nearer than a usable one - so the crew knows not to lay in from it. */
function isOutOfService(hydrant: NearestHydrant): boolean {
  return hydrant.status === 'OUT_OF_SERVICE';
}

/**
 * "H-014 · 90 m · 6-inch · 1000 gpm (class A)" / "H-015 · 15 m · OUT OF SERVICE" - one
 * glanceable line per hydrant.
 */
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
    isOutOfService(hydrant) ? 'OUT OF SERVICE' : undefined,
    hydrant.size,
    flow,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
}

/** The occupancy's own summary: occupancySummary when the server sends provenance. */
function summaryOf(prePlan: PrePlanEnrichment): string | undefined {
  return prePlan.matchType ? prePlan.occupancySummary : prePlan.summary;
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
      // Always a warning (R3-C): the dispatched unit may be a separate structure - a rear
      // cottage, Bldg 2, Lot 12 - that the main building's plan does not describe.
      return {
        text: `VERIFY ADDRESS: building-level pre-plan${address ? ` for ${address}` : ''}; no plan for ${prePlan.dispatchUnit ?? 'the dispatched unit'}.`,
        warning: true,
      };
    case 'ADDRESS_UNVERIFIED':
      // Same street address, but the town (or the address itself) could not be confirmed as
      // this call's - e.g. a dispatch that may be in another town.
      return {
        text: `VERIFY ADDRESS: pre-plan for ${address ?? 'this street address'}, but its town could not be confirmed as this call's.`,
        warning: true,
      };
    case 'UNIT_MISMATCH':
      return {
        // The server also returns this for a dispatch that named no unit, so say only what is
        // known: the plan covers one unit, not the whole address.
        text: `VERIFY ADDRESS: this pre-plan is for ${withUnit(address ?? 'one unit', prePlan.unit)} only.`,
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

export const UNAVAILABLE_TEXT =
  'Pre-plan unavailable right now. This does not mean there is no pre-plan for this address.';
export const NO_MATCH_TEXT = 'No pre-plan matched this address.';

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

const HYDRANTS_UNAVAILABLE_TEXT = 'Hydrant list unavailable right now.';
const HYDRANTS_INCOMPLETE_TEXT = 'Hydrant list may be incomplete: a nearer hydrant may be missing.';

function HydrantSection({
  hydrants,
  unavailable,
  incomplete,
}: {
  hydrants: readonly NearestHydrant[];
  unavailable: boolean;
  incomplete: boolean;
}) {
  if (unavailable) {
    return (
      <p role="note" style={noticeStyle(true)}>
        {HYDRANTS_UNAVAILABLE_TEXT}
      </p>
    );
  }
  if (hydrants.length === 0) return null;
  return (
    <div>
      <h3 style={{ fontSize: 15, fontWeight: 600 }}>Nearest hydrants</h3>
      {incomplete ? (
        <p role="note" style={noticeStyle(true)}>
          {HYDRANTS_INCOMPLETE_TEXT}
        </p>
      ) : null}
      <ul aria-label="Nearest hydrants">
        {hydrants.map((hydrant) => (
          <li
            key={hydrant.hydrantId}
            style={
              isOutOfService(hydrant)
                ? { color: 'var(--bx-status-danger)', fontWeight: 700 }
                : undefined
            }
          >
            {describeHydrant(hydrant)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function MatchedPrePlan({ prePlan }: { prePlan: PrePlanEnrichment }) {
  const notice = matchNotice(prePlan);
  return (
    <>
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

      {summaryOf(prePlan) ? <p>{summaryOf(prePlan)}</p> : null}
      <HazardList hazards={prePlan.hazards} />
      <ShutoffList shutoffs={prePlan.utilityShutoffs} />
    </>
  );
}

// E1-S17-UI / E5-S8-UI: same alerting-route enrichment as mobile (N1.5 - never /inspections/*).
// Nearest hydrants render whether or not a pre-plan matched: the top-level list when the
// server sends one (it includes flagged out-of-service hydrants), else the pre-plan's own.
export function PrePlanPanel({
  prePlan,
  unavailable = false,
  nearestHydrants,
  hydrantsUnavailable = false,
  hydrantsIncomplete = false,
}: {
  prePlan: PrePlanEnrichment | null | undefined;
  /** The lookup failed: say so, never "no pre-plan" (a throttle is not an empty binder). */
  unavailable?: boolean;
  nearestHydrants?: readonly NearestHydrant[];
  hydrantsUnavailable?: boolean;
  hydrantsIncomplete?: boolean;
}) {
  const hydrants = nearestHydrants ?? prePlan?.nearestHydrants ?? [];
  if (!unavailable && prePlan === undefined && hydrants.length === 0 && !hydrantsUnavailable) {
    return null;
  }

  return (
    <Card title="Pre-plan">
      {unavailable ? (
        <p role="note" style={noticeStyle(true)}>
          {UNAVAILABLE_TEXT}
        </p>
      ) : prePlan === null ? (
        <p>{NO_MATCH_TEXT}</p>
      ) : prePlan ? (
        <MatchedPrePlan prePlan={prePlan} />
      ) : null}
      <HydrantSection
        hydrants={hydrants}
        unavailable={hydrantsUnavailable}
        incomplete={hydrantsIncomplete}
      />
    </Card>
  );
}
