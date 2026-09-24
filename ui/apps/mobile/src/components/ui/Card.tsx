import { radius, spacing, typeScale } from '@boxalarm/design-tokens';
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import { useTheme } from './theme';

interface CardProps {
  title?: string;
  children: ReactNode;
}

export function Card({ title, children }: CardProps) {
  const theme = useTheme();
  return (
    <View
      style={{
        backgroundColor: theme.surface,
        borderRadius: radius.card,
        borderWidth: 1,
        borderColor: theme.borderDecorative,
        padding: spacing.lg,
        gap: spacing.sm,
      }}
    >
      {title ? (
        <Text style={{ color: theme.fg, fontSize: typeScale.heading.size, fontWeight: '600' }}>
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
        backgroundColor: theme.surface,
        borderRadius: radius.card,
        borderWidth: 1,
        borderColor: theme.borderDecorative,
        padding: spacing.md,
        gap: 4,
        flex: 1,
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
