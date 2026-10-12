import { radiusScale, spacing, typeScale } from '@boxalarm/design-tokens';
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import { cardShadow, useTheme } from './theme';

interface CardProps {
  title?: string;
  children: ReactNode;
}

export function Card({ title, children }: CardProps) {
  const theme = useTheme();
  return (
    <View
      style={{
        backgroundColor: theme.card,
        borderRadius: radiusScale.lg,
        borderWidth: 1,
        borderColor: theme.borderDecorative,
        padding: spacing.md,
        gap: spacing.sm,
        ...cardShadow(theme),
      }}
    >
      {title ? (
        <Text
          accessibilityRole="header"
          style={{ color: theme.fg, fontSize: typeScale.heading.size, fontWeight: '700' }}
        >
          {title}
        </Text>
      ) : null}
      {children}
    </View>
  );
}

interface StatProps {
  label: string;
  value: string;
  alarm?: boolean;
}

export function Stat({ label, value, alarm = false }: StatProps) {
  const theme = useTheme();
  return (
    <View
      style={{
        backgroundColor: theme.card,
        borderRadius: radiusScale.lg,
        borderWidth: 1,
        borderColor: theme.borderDecorative,
        padding: spacing.md,
        gap: 4,
        flex: 1,
        ...cardShadow(theme),
      }}
    >
      <Text style={{ color: theme.fgMuted, fontSize: typeScale.caption.size, fontWeight: '600' }}>
        {label}
      </Text>
      <Text
        style={{
          color: alarm ? theme.status.danger : theme.fg,
          fontSize: typeScale.title.size,
          fontWeight: '700',
        }}
      >
        {value}
      </Text>
    </View>
  );
}
