import { palette, spacing, typography } from '@boxalarm/design-tokens';
import { Text, useColorScheme } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export function PlaceholderScreen({ label }: { label: string }) {
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;

  return (
    <SafeAreaView
      style={{
        flex: 1,
        backgroundColor: tokens.background,
        alignItems: 'center',
        justifyContent: 'center',
        padding: spacing.lg,
      }}
    >
      <Text style={{ color: tokens.foreground, fontSize: typography.size.base }}>{label}</Text>
    </SafeAreaView>
  );
}
