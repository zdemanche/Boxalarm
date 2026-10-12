import { statusChipPalette, typeScale, type StatusRole } from '@boxalarm/design-tokens';
import { Text, View } from 'react-native';
import { useTheme } from './theme';

// Text glyphs, not an icon library — no react-native-svg dependency to link natively in this
// repo (CI here has no Xcode/Android SDK to build against). Shape, not colour, still carries
// the meaning alongside the word, per docs/design.md §2.3.
const STATUS_GLYPH: Record<StatusRole, string> = {
  ok: '●',
  warning: '◐',
  caution: '▲',
  danger: '⊠',
  info: '⬆',
  neutral: '○',
};

interface StatusChipProps {
  status: StatusRole;
  label: string;
}

/** A pill on the opaque chip fill/label pair (a11y-spec §1.2, AA-tested in design-tokens), so the
 * label holds its contrast on any card - the same chip as the web console. */
export function StatusChip({ status, label }: StatusChipProps) {
  const theme = useTheme();
  const chip = statusChipPalette[theme.palette][status];

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        alignSelf: 'flex-start',
        paddingVertical: 5,
        paddingHorizontal: 12,
        borderRadius: 999,
        backgroundColor: chip.fill,
      }}
    >
      <Text style={{ color: chip.onFill, fontSize: typeScale.label.size }} accessible={false}>
        {STATUS_GLYPH[status]}
      </Text>
      <Text style={{ color: chip.onFill, fontSize: typeScale.label.size, fontWeight: '700' }}>
        {label}
      </Text>
    </View>
  );
}
