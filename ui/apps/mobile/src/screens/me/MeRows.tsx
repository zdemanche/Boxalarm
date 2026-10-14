import { spacing, targetSize, typeScale, type StatusRole } from '@boxalarm/design-tokens';
import { Children, isValidElement, type ReactNode } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { StatusChip, useTheme } from '../../components/ui';
import {
  certificationStatusLabel,
  type CertificationStatus,
} from '../../features/me/certificationStatus';

/** Field rows: primary text 17/600 (docs/design.md §1, field body 17). */
export const ROW_TITLE_SIZE = 17;

/**
 * A card's list: each row divided from the one above by a hairline. Wrapping the rows in one view
 * keeps the Card's own gap from opening space between them.
 */
export function Rows({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return (
    <View>
      {Children.toArray(children).map((child, index) => (
        <View
          key={isValidElement(child) && child.key !== null ? child.key : index}
          style={
            index === 0 ? undefined : { borderTopWidth: 1, borderTopColor: theme.borderDecorative }
          }
        >
          {child}
        </View>
      ))}
    </View>
  );
}

function RowText({ title, detail }: { title: string; detail?: string }) {
  const theme = useTheme();
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <Text style={{ color: theme.fg, fontSize: ROW_TITLE_SIZE, fontWeight: '600' }}>{title}</Text>
      {detail ? (
        <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>{detail}</Text>
      ) : null}
    </View>
  );
}

/**
 * A settings-style row that opens another screen. The spoken name is the title (or an explicit
 * name), never the chevron; the detail line is read as the hint.
 */
export function NavRow({
  title,
  detail,
  accessibilityLabel,
  onPress,
}: {
  title: string;
  detail?: string;
  accessibilityLabel?: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityHint={detail}
      onPress={onPress}
      style={{
        minHeight: targetSize.field,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingVertical: spacing.sm,
      }}
    >
      <RowText title={title} detail={detail} />
      <Text
        accessible={false}
        importantForAccessibility="no"
        style={{ color: theme.fgFaint, fontSize: 28, fontWeight: '300' }}
      >
        ›
      </Text>
    </TouchableOpacity>
  );
}

/** A read-only row: title, optional detail line, and a trailing status chip or value. */
export function InfoRow({
  title,
  detail,
  trailing,
  accessible,
  accessibilityLabel,
}: {
  title: string;
  detail?: string;
  trailing?: ReactNode;
  accessible?: boolean;
  accessibilityLabel?: string;
}) {
  return (
    <View
      accessible={accessible ?? (accessibilityLabel ? true : undefined)}
      accessibilityLabel={accessibilityLabel}
      style={{
        minHeight: targetSize.field,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingVertical: spacing.sm,
      }}
    >
      <RowText title={title} detail={detail} />
      {trailing ? <View>{trailing}</View> : null}
    </View>
  );
}

const CERTIFICATION_ROLE: Record<CertificationStatus, StatusRole> = {
  CURRENT: 'ok',
  EXPIRED: 'danger',
  REVOKED: 'danger',
};

/** A certification's status, glyph + word + colour (docs/design.md §2.3: Expired is alarm). */
export function CertificationChip({ status }: { status: CertificationStatus }) {
  return (
    <StatusChip status={CERTIFICATION_ROLE[status]} label={certificationStatusLabel(status)} />
  );
}
