import { palette, spacing, typography } from '@boxalarm/design-tokens';
import { Text, useColorScheme, View } from 'react-native';
import type { NearestHydrant, PrePlanEnrichment, UtilityShutoff } from './types';

type Tokens = (typeof palette)[keyof typeof palette];

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

function Heading({ tokens, children }: { tokens: Tokens; children: string }) {
  return (
    <Text style={{ color: tokens.foreground, fontSize: typography.size.sm, fontWeight: '600' }}>
      {children}
    </Text>
  );
}

function HazardList({ tokens, hazards }: { tokens: Tokens; hazards: readonly string[] }) {
  if (hazards.length === 0) return null;
  return (
    <View style={{ marginTop: spacing.md }}>
      <Heading tokens={tokens}>Hazards</Heading>
      {hazards.map((hazard) => (
        <Text
          key={hazard}
          style={{ color: tokens.error, fontSize: typography.size.sm, marginTop: 2 }}
        >
          {hazard}
        </Text>
      ))}
    </View>
  );
}

function ShutoffList({
  tokens,
  shutoffs,
}: {
  tokens: Tokens;
  shutoffs: readonly UtilityShutoff[];
}) {
  if (shutoffs.length === 0) return null;
  return (
    <View style={{ marginTop: spacing.md }}>
      <Heading tokens={tokens}>Utility shutoffs</Heading>
      {shutoffs.map((shutoff) => (
        <Text
          key={`${shutoff.utility}-${shutoff.location}`}
          style={{ color: tokens.foreground, fontSize: typography.size.sm, marginTop: 2 }}
        >
          {shutoff.utility}: {shutoff.location}
        </Text>
      ))}
    </View>
  );
}

const HYDRANTS_UNAVAILABLE_TEXT = 'Hydrant list unavailable right now.';

function WarningNotice({ tokens, children }: { tokens: Tokens; children: string }) {
  return (
    <Text
      accessibilityRole="alert"
      style={{
        color: tokens.warning,
        fontSize: typography.size.base,
        fontWeight: '700',
        marginTop: spacing.xs,
        borderLeftWidth: 4,
        borderLeftColor: tokens.warning,
        paddingLeft: spacing.sm,
      }}
    >
      {children}
    </Text>
  );
}

function HydrantSection({
  tokens,
  hydrants,
  unavailable,
}: {
  tokens: Tokens;
  hydrants: readonly NearestHydrant[];
  unavailable: boolean;
}) {
  if (unavailable)
    return <WarningNotice tokens={tokens}>{HYDRANTS_UNAVAILABLE_TEXT}</WarningNotice>;
  if (hydrants.length === 0) return null;
  return (
    <View style={{ marginTop: spacing.md }}>
      <Heading tokens={tokens}>Nearest hydrants</Heading>
      {hydrants.map((hydrant) => (
        <Text
          key={hydrant.hydrantId}
          style={{
            color: isOutOfService(hydrant) ? tokens.error : tokens.foreground,
            fontWeight: isOutOfService(hydrant) ? '700' : '400',
            fontSize: typography.size.sm,
            marginTop: 2,
          }}
        >
          {describeHydrant(hydrant)}
        </Text>
      ))}
    </View>
  );
}

function MatchedPrePlan({ tokens, prePlan }: { tokens: Tokens; prePlan: PrePlanEnrichment }) {
  const notice = matchNotice(prePlan);
  return (
    <>
      {notice ? (
        notice.warning ? (
          <WarningNotice tokens={tokens}>{notice.text}</WarningNotice>
        ) : (
          <Text
            style={{
              color: tokens.foreground,
              fontSize: typography.size.base,
              fontWeight: '600',
              marginTop: spacing.xs,
            }}
          >
            {notice.text}
          </Text>
        )
      ) : null}

      {prePlan.matchType === 'CANDIDATES'
        ? (prePlan.candidates ?? []).map((candidate) => (
            <View key={candidate.occupancyId} style={{ marginTop: spacing.md }}>
              <Text
                style={{
                  color: tokens.foreground,
                  fontSize: typography.size.base,
                  fontWeight: '700',
                }}
              >
                {withUnit(candidate.matchedAddress, candidate.unit)}
                {candidate.distanceMeters !== undefined ? ` · ${candidate.distanceMeters} m` : ''}
              </Text>
              {candidate.summary ? (
                <Text style={{ color: tokens.foreground, fontSize: typography.size.sm }}>
                  {candidate.summary}
                </Text>
              ) : null}
              <HazardList tokens={tokens} hazards={candidate.hazards} />
              <ShutoffList tokens={tokens} shutoffs={candidate.utilityShutoffs} />
            </View>
          ))
        : null}

      {prePlan.summary ? (
        <Text
          style={{
            color: tokens.foreground,
            fontSize: typography.size.base,
            marginTop: spacing.xs,
          }}
        >
          {prePlan.summary}
        </Text>
      ) : null}

      <HazardList tokens={tokens} hazards={prePlan.hazards} />
      <ShutoffList tokens={tokens} shutoffs={prePlan.utilityShutoffs} />
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
}: {
  prePlan: PrePlanEnrichment | null | undefined;
  /** The lookup failed: say so, never "no pre-plan" (a throttle is not an empty binder). */
  unavailable?: boolean;
  nearestHydrants?: readonly NearestHydrant[];
  hydrantsUnavailable?: boolean;
}) {
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;
  const hydrants = nearestHydrants ?? prePlan?.nearestHydrants ?? [];

  if (!unavailable && prePlan === undefined && hydrants.length === 0 && !hydrantsUnavailable) {
    return null;
  }

  return (
    <View style={{ marginTop: spacing.lg }}>
      <Text
        accessibilityRole="header"
        style={{ color: tokens.foreground, fontSize: typography.size.lg, fontWeight: '700' }}
      >
        Pre-plan
      </Text>
      {unavailable ? (
        <WarningNotice tokens={tokens}>{UNAVAILABLE_TEXT}</WarningNotice>
      ) : prePlan === null ? (
        <Text style={{ color: tokens.foreground, opacity: 0.7, fontSize: typography.size.base }}>
          {NO_MATCH_TEXT}
        </Text>
      ) : prePlan ? (
        <MatchedPrePlan tokens={tokens} prePlan={prePlan} />
      ) : null}
      <HydrantSection tokens={tokens} hydrants={hydrants} unavailable={hydrantsUnavailable} />
    </View>
  );
}
