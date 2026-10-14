import { radiusScale, spacing, targetSize, typeScale } from '@boxalarm/design-tokens';
import { Text, TouchableOpacity } from 'react-native';
import { useTheme } from '../../components/ui';
import { ROW_TEXT_SIZE } from './fieldText';

interface RadioOptionProps {
  label: string;
  selected: boolean;
  onPress: () => void;
  /** Exposed in the accessibility state only when the caller passes it. */
  disabled?: boolean;
}

/** One glove-sized choice in a pick-from-list group (severity, out-of-service reason). The
 * selection is carried by glyph, weight and the amber selection mark - never colour alone
 * (docs/design.md §2.3). */
export function RadioOption({ label, selected, onPress, disabled }: RadioOptionProps) {
  const theme = useTheme();
  return (
    <TouchableOpacity
      accessibilityRole="radio"
      accessibilityState={
        disabled === undefined ? { checked: selected } : { checked: selected, disabled }
      }
      disabled={disabled}
      onPress={onPress}
      style={{
        minHeight: targetSize.field,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingHorizontal: spacing.md,
        borderRadius: radiusScale.lg,
        borderWidth: selected ? 2 : 1,
        borderColor: selected ? theme.indicator : theme.border,
        backgroundColor: selected ? theme.accentSubtle : theme.card,
      }}
    >
      <Text
        accessible={false}
        style={{
          color: selected ? theme.indicator : theme.fgMuted,
          fontSize: typeScale.heading.size,
        }}
      >
        {selected ? '●' : '○'}
      </Text>
      <Text
        style={{
          flex: 1,
          color: theme.fg,
          fontSize: ROW_TEXT_SIZE,
          fontWeight: selected ? '700' : '500',
        }}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}
