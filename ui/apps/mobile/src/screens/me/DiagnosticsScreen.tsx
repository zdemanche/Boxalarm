import { typeScale } from '@boxalarm/design-tokens';
import { Text } from 'react-native';
import { Screen, useTheme } from '../../components/ui';

// N8.3: pulls the delivery audit log and renders a timeline (dispatch received -> push sent ->
// delivered -> opened -> response logged, per tone). That log lives in alerting-service
// (boxalarm-backend), which this session has no access to yet.
export function DiagnosticsScreen() {
  const theme = useTheme();

  return (
    <Screen>
      <Text
        accessibilityRole="header"
        style={{ color: theme.fg, fontSize: typeScale.title.size, fontWeight: '700' }}
      >
        Why didn&apos;t I get the page?
      </Text>
      <Text
        style={{
          color: theme.fgMuted,
          fontSize: typeScale.body.size,
          marginTop: 8,
        }}
      >
        Once connected, this shows a per-tone timeline for your most recent dispatches — sent,
        delivered, and opened on each channel — so you can see exactly where a page didn&apos;t
        land.
      </Text>
      <Text style={{ color: theme.fgMuted, fontSize: typeScale.caption.size, marginTop: 24 }}>
        Diagnostics is not yet connected — this needs alerting-service's audit log to be reachable.
      </Text>
    </Screen>
  );
}
