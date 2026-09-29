import { radius, spacing, statusChipPalette, typeScale } from '@boxalarm/design-tokens';
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
        borderColor: danger.onFill,
        borderWidth: 2,
        borderRadius: radius.default,
        padding: spacing.md,
        gap: spacing.sm,
        marginBottom: spacing.md,
      }}
    >
      <Text
        accessibilityRole="header"
        style={{ color: danger.onFill, fontSize: typeScale.heading.size, fontWeight: '700' }}
      >
        ⊠ {READINESS_BANNER_TITLE}
      </Text>
      {blocking.map((item) => (
        <Text key={item.id} style={{ color: danger.onFill, fontSize: typeScale.body.size }}>
          {item.label}: {item.detail}
        </Text>
      ))}
      {first.fix ? (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={`Fix: ${first.label}`}
          onPress={first.fix}
          style={{
            minHeight: 72,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: radius.default,
            backgroundColor: danger.onFill,
            paddingHorizontal: spacing.md,
          }}
        >
          <Text style={{ color: danger.fill, fontSize: typeScale.label.size, fontWeight: '700' }}>
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
            minHeight: 72,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: radius.default,
            borderWidth: 2,
            borderColor: danger.onFill,
          }}
        >
          <Text
            style={{
              color: danger.onFill,
              fontSize: typeScale.label.size,
              fontWeight: '700',
            }}
          >
            See all checks and test my phone
          </Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}
