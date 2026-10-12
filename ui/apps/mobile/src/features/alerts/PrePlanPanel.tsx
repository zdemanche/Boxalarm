import { radiusScale, spacing, statusChipPalette, typeScale } from '@boxalarm/design-tokens';
import type { ReactNode } from 'react';
import { Platform, Text, View } from 'react-native';
import { Card, useTheme, type SurfaceTheme } from '../../components/ui';
import type { NearestHydrant, PrePlanEnrichment, UtilityShutoff } from './types';

/** Field body text (design.md §1: body 17 on the field surface). */
const BODY = { size: 17, lineHeight: 24 };

export const UNAVAILABLE_TEXT =
  'Pre-plan unavailable right now. This does not mean there is no pre-plan for this address.';
export const NO_MATCH_TEXT = 'No pre-plan matched this address.';

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

function Heading({ theme, children }: { theme: SurfaceTheme; children: string }) {
  return (
    <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size, fontWeight: '700' }}>
      {children}
    </Text>
  );
}

/** A sub-section of the card, set off by a divider. */
function Section({ theme, children }: { theme: SurfaceTheme; children: ReactNode }) {
  return (
    <View
      style={{
        marginTop: spacing.xs,
        paddingTop: spacing.sm,
        gap: 4,
        borderTopWidth: 1,
        borderTopColor: theme.borderDecorative,
      }}
    >
      {children}
    </View>
  );
}

function HazardList({ theme, hazards }: { theme: SurfaceTheme; hazards: readonly string[] }) {
  if (hazards.length === 0) return null;
  return (
    <Section theme={theme}>
      <Heading theme={theme}>Hazards</Heading>
      {hazards.map((hazard) => (
        <Text
          key={hazard}
          style={{ color: theme.status.danger, fontSize: BODY.size, fontWeight: '700' }}
        >
          {hazard}
        </Text>
      ))}
    </Section>
  );
}

function ShutoffList({
  theme,
  shutoffs,
}: {
  theme: SurfaceTheme;
  shutoffs: readonly UtilityShutoff[];
}) {
  if (shutoffs.length === 0) return null;
  return (
    <Section theme={theme}>
      <Heading theme={theme}>Utility shutoffs</Heading>
      {shutoffs.map((shutoff) => (
        <Text
          key={`${shutoff.utility}-${shutoff.location}`}
          style={{ color: theme.fg, fontSize: BODY.size }}
        >
          {shutoff.utility}: {shutoff.location}
        </Text>
      ))}
    </Section>
  );
}

const HYDRANTS_UNAVAILABLE_TEXT = 'Hydrant list unavailable right now.';
const HYDRANTS_INCOMPLETE_TEXT = 'Hydrant list may be incomplete: a nearer hydrant may be missing.';

/** On the opaque warning chip pair (a11y-spec §1.2); the words carry it, never the colour. */
function WarningNotice({ theme, children }: { theme: SurfaceTheme; children: string }) {
  const chip = statusChipPalette[theme.palette].warning;
  return (
    <Text
      accessibilityRole="alert"
      style={{
        color: chip.onFill,
        backgroundColor: chip.fill,
        fontSize: BODY.size,
        lineHeight: BODY.lineHeight,
        fontWeight: '700',
        marginTop: spacing.xs,
        padding: spacing.sm,
        paddingLeft: spacing.md,
        borderLeftWidth: 4,
        borderLeftColor: chip.onFill,
        borderRadius: radiusScale.md,
        overflow: 'hidden',
      }}
    >
      {children}
    </Text>
  );
}

function HydrantSection({
  theme,
  hydrants,
  unavailable,
  incomplete,
}: {
  theme: SurfaceTheme;
  hydrants: readonly NearestHydrant[];
  unavailable: boolean;
  incomplete: boolean;
}) {
  if (unavailable) return <WarningNotice theme={theme}>{HYDRANTS_UNAVAILABLE_TEXT}</WarningNotice>;
  if (hydrants.length === 0) return null;
  return (
    <Section theme={theme}>
      <Heading theme={theme}>Nearest hydrants</Heading>
      {incomplete ? <WarningNotice theme={theme}>{HYDRANTS_INCOMPLETE_TEXT}</WarningNotice> : null}
      {hydrants.map((hydrant) => (
        <Text
          key={hydrant.hydrantId}
          style={{
            color: isOutOfService(hydrant) ? theme.status.danger : theme.fg,
            fontWeight: isOutOfService(hydrant) ? '700' : '400',
            fontSize: BODY.size,
            fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
          }}
        >
          {describeHydrant(hydrant)}
        </Text>
      ))}
    </Section>
  );
}

function MatchedPrePlan({ theme, prePlan }: { theme: SurfaceTheme; prePlan: PrePlanEnrichment }) {
  const notice = matchNotice(prePlan);
  return (
    <>
      {notice ? (
        notice.warning ? (
          <WarningNotice theme={theme}>{notice.text}</WarningNotice>
        ) : (
          <Text style={{ color: theme.fg, fontSize: BODY.size, fontWeight: '700' }}>
            {notice.text}
          </Text>
        )
      ) : null}

      {prePlan.matchType === 'CANDIDATES'
        ? (prePlan.candidates ?? []).map((candidate) => (
            <Section key={candidate.occupancyId} theme={theme}>
              <Text style={{ color: theme.fg, fontSize: BODY.size, fontWeight: '700' }}>
                {withUnit(candidate.matchedAddress, candidate.unit)}
                {candidate.distanceMeters !== undefined ? ` · ${candidate.distanceMeters} m` : ''}
              </Text>
              {candidate.summary ? (
                <Text style={{ color: theme.fg, fontSize: typeScale.body.size }}>
                  {candidate.summary}
                </Text>
              ) : null}
              <HazardList theme={theme} hazards={candidate.hazards} />
              <ShutoffList theme={theme} shutoffs={candidate.utilityShutoffs} />
            </Section>
          ))
        : null}

      {summaryOf(prePlan) ? (
        <Text style={{ color: theme.fg, fontSize: BODY.size, lineHeight: BODY.lineHeight }}>
          {summaryOf(prePlan)}
        </Text>
      ) : null}

      <HazardList theme={theme} hazards={prePlan.hazards} />
      <ShutoffList theme={theme} shutoffs={prePlan.utilityShutoffs} />
    </>
  );
}

// E1-S17-UI / E5-S8-UI: pre-plan/hydrant enrichment, sourced only from the alerting-service
// dispatch-detail response (N1.5 - never a call to /inspections/*). Renders nothing (no empty
// shell, no spinner) when the dispatch carries neither a pre-plan answer nor hydrants, per AC2.
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
  const theme = useTheme();
  const hydrants = nearestHydrants ?? prePlan?.nearestHydrants ?? [];

  if (!unavailable && prePlan === undefined && hydrants.length === 0 && !hydrantsUnavailable) {
    return null;
  }

  return (
    <Card title="Pre-plan">
      {unavailable ? (
        <WarningNotice theme={theme}>{UNAVAILABLE_TEXT}</WarningNotice>
      ) : prePlan === null ? (
        <Text style={{ color: theme.fgMuted, fontSize: BODY.size }}>{NO_MATCH_TEXT}</Text>
      ) : prePlan ? (
        <MatchedPrePlan theme={theme} prePlan={prePlan} />
      ) : null}
      <HydrantSection
        theme={theme}
        hydrants={hydrants}
        unavailable={hydrantsUnavailable}
        incomplete={hydrantsIncomplete}
      />
    </Card>
  );
}
