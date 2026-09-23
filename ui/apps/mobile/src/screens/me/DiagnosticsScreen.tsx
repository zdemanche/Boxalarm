import { palette, spacing, typography } from '@boxalarm/design-tokens';
import { Text, useColorScheme } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// N8.3: pulls the delivery audit log and renders a timeline (dispatch received -> push sent ->
// delivered -> opened -> response logged, per tone). That log lives in alerting-service
// (boxalarm-backend), which this session has no access to yet.
export function DiagnosticsScreen() {
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background, padding: spacing.lg }}>
      <Text
        accessibilityRole="header"
        style={{ color: tokens.foreground, fontSize: typography.size.lg, fontWeight: '700' }}
      >
        Why didn&apos;t I get the page?
      </Text>
      <Text
        style={{
          color: tokens.foreground,
          opacity: 0.7,
          fontSize: typography.size.base,
          marginTop: spacing.sm,
        }}
      >
        Once connected, this shows a per-tone timeline for your most recent dispatches — sent,
        delivered, and opened on each channel — so you can see exactly where a page didn&apos;t
        land.
      </Text>
      <Text
        style={{ color: tokens.foreground, fontSize: typography.size.sm, marginTop: spacing.lg }}
      >
        Diagnostics is not yet connected — this needs alerting-service's audit log to be reachable.
      </Text>
    </SafeAreaView>
  );
}
