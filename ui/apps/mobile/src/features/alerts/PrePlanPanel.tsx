import { palette, spacing, typography } from '@boxalarm/design-tokens';
import { Text, useColorScheme, View } from 'react-native';
import type { PrePlanEnrichment } from './types';

// E1-S17-UI / E5-S8-UI: pre-plan/hydrant enrichment, sourced only from the alerting-service
// dispatch-detail response (N1.5 - never a call to /inspections/*). Renders nothing (no empty
// shell, no spinner) when the dispatch carries no pre-plan copy, per AC2.
export function PrePlanPanel({ prePlan }: { prePlan: PrePlanEnrichment | null | undefined }) {
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;

  if (prePlan === undefined) return null;

  if (prePlan === null) {
    return (
      <View style={{ marginTop: spacing.lg }}>
        <Text
          accessibilityRole="header"
          style={{ color: tokens.foreground, fontSize: typography.size.lg, fontWeight: '700' }}
        >
          Pre-plan
        </Text>
        <Text style={{ color: tokens.foreground, opacity: 0.7, fontSize: typography.size.base }}>
          No pre-plan on file for this address.
        </Text>
      </View>
    );
  }

  return (
    <View style={{ marginTop: spacing.lg }}>
      <Text
        accessibilityRole="header"
        style={{ color: tokens.foreground, fontSize: typography.size.lg, fontWeight: '700' }}
      >
        Pre-plan
      </Text>
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

      {prePlan.hazards.length > 0 ? (
        <View style={{ marginTop: spacing.md }}>
          <Text
            style={{ color: tokens.foreground, fontSize: typography.size.sm, fontWeight: '600' }}
          >
            Hazards
          </Text>
          {prePlan.hazards.map((hazard) => (
            <Text
              key={hazard}
              style={{ color: tokens.error, fontSize: typography.size.sm, marginTop: 2 }}
            >
              {hazard}
            </Text>
          ))}
        </View>
      ) : null}

      {prePlan.utilityShutoffs.length > 0 ? (
        <View style={{ marginTop: spacing.md }}>
          <Text
            style={{ color: tokens.foreground, fontSize: typography.size.sm, fontWeight: '600' }}
          >
            Utility shutoffs
          </Text>
          {prePlan.utilityShutoffs.map((shutoff) => (
            <Text
              key={`${shutoff.utility}-${shutoff.location}`}
              style={{ color: tokens.foreground, fontSize: typography.size.sm, marginTop: 2 }}
            >
              {shutoff.utility}: {shutoff.location}
            </Text>
          ))}
        </View>
      ) : null}

      {prePlan.nearestHydrants.length > 0 ? (
        <View style={{ marginTop: spacing.md }}>
          <Text
            style={{ color: tokens.foreground, fontSize: typography.size.sm, fontWeight: '600' }}
          >
            Nearest hydrants
          </Text>
          {prePlan.nearestHydrants.map((hydrant) => (
            <Text
              key={hydrant.hydrantId}
              style={{ color: tokens.foreground, fontSize: typography.size.sm, marginTop: 2 }}
            >
              {hydrant.hydrantId}
              {hydrant.size ? ` · ${hydrant.size}` : ''}
              {hydrant.flowRatingGpm ? ` · ${hydrant.flowRatingGpm} gpm` : ''}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}
