import { radiusScale, spacing, statusChipPalette, typeScale } from '@boxalarm/design-tokens';
import { Text, TouchableOpacity, useColorScheme, View } from 'react-native';
import type { ReadinessItem } from './useAlertReadiness';

export const READINESS_BANNER_TITLE = 'This phone may not wake you for a page';

interface AlertReadinessBannerProps {
  blocking: readonly ReadinessItem[];
  /** Where "See all checks" goes (the self-test readiness checklist); omitted there. */
  onSeeAll?: () => void;
}

/**
 * Persistent red banner (alert-ux C8/R1): shown whenever a device condition would stop a page
 * from waking the member, never dismissible while it is true. Names each reason in words and
 * fixes the first one in one tap. Opaque chip colours so the text clears AA on either palette.
 */
export function AlertReadinessBanner({ blocking, onSeeAll }: AlertReadinessBannerProps) {
  const scheme = useColorScheme();
  const danger = statusChipPalette[scheme === 'dark' ? 'cab' : 'day'].danger;
  if (blocking.length === 0) return null;
  const first = blocking[0]!;

  return (
    <View
      accessibilityRole="alert"
      style={{
        backgroundColor: danger.fill,
        borderRadius: radiusScale.lg,
        borderLeftWidth: 4,
        borderLeftColor: danger.onFill,
        padding: spacing.md,
        gap: spacing.xs,
        marginBottom: spacing.sm,
      }}
    >
      <Text
        accessibilityRole="header"
        style={{ color: danger.onFill, fontSize: typeScale.subheading.size, fontWeight: '700' }}
      >
        ⊠ {READINESS_BANNER_TITLE}
      </Text>
      {blocking.map((item) => (
        <Text key={item.id} style={{ color: danger.onFill, fontSize: typeScale.bodyDense.size }}>
          {item.label}: {item.detail}
        </Text>
      ))}
      {/* Side by side, not stacked: the banner shows on every tab and must not take the screen.
          Both stay at the 72dp alert-path floor. */}
      <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs }}>
        {first.fix ? (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={`Fix: ${first.label}`}
            onPress={first.fix}
            style={{
              flex: 1,
              minHeight: 72,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: radiusScale.lg,
              backgroundColor: danger.onFill,
              paddingHorizontal: spacing.sm,
            }}
          >
            <Text
              style={{
                color: danger.fill,
                fontSize: typeScale.label.size,
                fontWeight: '700',
                textAlign: 'center',
              }}
            >
              Fix: {first.fixLabel ?? first.label}
            </Text>
          </TouchableOpacity>
        ) : null}
        {onSeeAll ? (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="See all alert readiness checks"
            onPress={onSeeAll}
            style={{
              flex: 1,
              minHeight: 72,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: radiusScale.lg,
              borderWidth: 2,
              borderColor: danger.onFill,
              paddingHorizontal: spacing.sm,
            }}
          >
            <Text
              style={{
                color: danger.onFill,
                fontSize: typeScale.label.size,
                fontWeight: '700',
                textAlign: 'center',
              }}
            >
              See all checks and test my phone
            </Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}
