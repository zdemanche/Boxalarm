import {
  radiusScale,
  spacing,
  statusChipPalette,
  typeScale,
  type StatusRole,
} from '@boxalarm/design-tokens';
import type { ReactNode } from 'react';
import {
  ScrollView,
  Text,
  View,
  type ScrollViewProps,
  type ViewProps,
  type ViewStyle,
} from 'react-native';
import { useOptionalAuth, type Role } from '../../auth/AuthContext';
import { Screen, useTheme, type SurfaceTheme } from '../../components/ui';
import { cardShadow } from '../../components/ui/theme';

/** The live-call edge (docs/design.md §2 amendment, web `.liveCard`): a 2px alarm border and a
 * 4px inset bar. Red on this surface means a live call and nothing else. */
const LIVE_BORDER = 2;
const LIVE_BAR = 4;

/** The card surface, for cards that need more than the kit's `Card` (an alarm edge, a live
 * region, a ref). Same fill, radius, border and shadow as `Card`. */
export function cardSurface(theme: SurfaceTheme): ViewStyle {
  return {
    backgroundColor: theme.card,
    borderRadius: radiusScale.lg,
    borderWidth: 1,
    borderColor: theme.borderDecorative,
    padding: spacing.md,
    gap: spacing.sm,
    ...cardShadow(theme),
  };
}

/** Divider between rows of a list card: every row but the first. */
export function rowDivider(theme: SurfaceTheme, index: number): ViewStyle {
  return index === 0
    ? {}
    : { borderTopWidth: 1, borderTopColor: theme.borderDecorative, paddingTop: spacing.sm };
}

/** A card that carries the live-call edge while `live` (default true); a plain card otherwise. */
export function LiveCard({ live = true, children }: { live?: boolean; children: ReactNode }) {
  const theme = useTheme();
  if (!live) return <View style={cardSurface(theme)}>{children}</View>;
  return (
    <View
      style={{
        ...cardSurface(theme),
        borderWidth: LIVE_BORDER,
        borderColor: theme.status.danger,
        paddingLeft: spacing.md + LIVE_BAR,
      }}
    >
      <View
        accessible={false}
        importantForAccessibility="no"
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: LIVE_BAR,
          backgroundColor: theme.status.danger,
          borderTopLeftRadius: radiusScale.lg - LIVE_BORDER,
          borderBottomLeftRadius: radiusScale.lg - LIVE_BORDER,
        }}
      />
      {children}
    </View>
  );
}

/** The alarm dot before a live card's title (web `.liveCard > h2::before`). Decorative. */
export function LiveDot() {
  const theme = useTheme();
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={{
        width: 18,
        height: 18,
        borderRadius: 9,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: statusChipPalette[theme.palette].danger.fill,
      }}
    >
      <View
        style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: theme.status.danger }}
      />
    </View>
  );
}

const NOTICE_GLYPH: Record<StatusRole, string> = {
  ok: '✓',
  warning: '▲',
  caution: '▲',
  danger: '⊠',
  info: 'ⓘ',
  neutral: '•',
};

interface NoticeProps extends Pick<ViewProps, 'accessibilityRole' | 'accessibilityLiveRegion'> {
  tone: StatusRole;
  children: ReactNode;
}

/** An inline notice on the opaque chip pair for its status (a11y-spec §1.2), glyph + words -
 * never colour alone. Its texts use `noticeText(theme, tone)`. */
export function Notice({ tone, children, ...a11y }: NoticeProps) {
  const theme = useTheme();
  const chip = statusChipPalette[theme.palette][tone];
  return (
    <View
      {...a11y}
      style={{
        flexDirection: 'row',
        gap: spacing.sm,
        padding: spacing.md,
        borderRadius: radiusScale.lg,
        borderLeftWidth: LIVE_BAR,
        borderLeftColor: chip.onFill,
        backgroundColor: chip.fill,
      }}
    >
      <Text
        accessible={false}
        importantForAccessibility="no"
        style={{ color: chip.onFill, fontSize: typeScale.heading.size, fontWeight: '700' }}
      >
        {NOTICE_GLYPH[tone]}
      </Text>
      <View style={{ flex: 1, gap: spacing.sm }}>{children}</View>
    </View>
  );
}

export function noticeText(theme: SurfaceTheme, tone: StatusRole, strong = false) {
  return {
    color: statusChipPalette[theme.palette][tone].onFill,
    fontSize: 17,
    lineHeight: 24,
    fontWeight: strong ? ('700' as const) : ('400' as const),
  };
}

/** `Screen scroll={false}` around a ScrollView that takes props the kit's scroller does not (a
 * refresh control, an accessibility container label, a touch hook). The ScrollView reclaims the
 * gutter so card shadows are not clipped, and lays out exactly like `Screen`'s own scroller. */
export function CanvasScrollView({
  children,
  ...props
}: ScrollViewProps & { children: ReactNode }) {
  return (
    <Screen scroll={false}>
      <ScrollView
        {...props}
        style={{ flex: 1, marginHorizontal: -spacing.lg, marginTop: -spacing.md }}
        contentContainerStyle={{
          paddingHorizontal: spacing.lg,
          paddingTop: spacing.md,
          paddingBottom: spacing.xl,
          gap: spacing.md,
          flexGrow: 1,
        }}
      >
        {children}
      </ScrollView>
    </Screen>
  );
}

/** A navigating row's trailing mark. Decorative: the row's own name says where it goes. */
export function Chevron() {
  const theme = useTheme();
  return (
    <Text
      accessible={false}
      importantForAccessibility="no"
      style={{ color: theme.fgFaint, fontSize: 28, lineHeight: 30, fontWeight: '300' }}
    >
      ›
    </Text>
  );
}

/** Primary text of a list row (17/600) and its muted secondary line. */
export const ROW_PRIMARY = { fontSize: 17, lineHeight: 22, fontWeight: '600' as const };
export const ROW_SECONDARY = {
  fontSize: typeScale.body.size,
  lineHeight: typeScale.body.lineHeight,
};

const RIDING_BOARD_ROLES: readonly Role[] = ['OFFICER', 'CHIEF'];

export function useCanAssignRiding(): boolean {
  const roles = useOptionalAuth()?.roles ?? [];
  return roles.some((role) => RIDING_BOARD_ROLES.includes(role));
}
