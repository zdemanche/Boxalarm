import { spacing } from '@boxalarm/design-tokens';
import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from './theme';

interface ScreenProps {
  children: ReactNode;
  scroll?: boolean;
}

/** Common screen chrome — the canvas the cards sit on. Field posture: no side gutter smaller
 * than `spacing.lg` (docs/design.md §1 spacing rhythm). Only the side insets are applied here:
 * every screen sits under a stack header (which owns the top inset) and above the tab bar (which
 * owns the bottom), and applying them again opened a blank band under each header. */
export function Screen({ children, scroll = true }: ScreenProps) {
  const theme = useTheme();

  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: theme.canvas }}>
      {scroll ? (
        <ScrollView
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
      ) : (
        <View
          style={{
            flex: 1,
            paddingHorizontal: spacing.lg,
            paddingTop: spacing.md,
            gap: spacing.md,
          }}
        >
          {children}
        </View>
      )}
    </SafeAreaView>
  );
}
