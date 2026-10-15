import { targetSize, typeScale } from '@boxalarm/design-tokens';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import type { NavigatorScreenParams } from '@react-navigation/native';
import { Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../components/ui/theme';
import { AlertsStack, type AlertsStackParamList } from './AlertsStack';
import { ChecksStack } from './ChecksStack';
import { MeStack, type MeStackParamList } from './MeStack';
import { ScheduleStack } from './ScheduleStack';

// Bottom tab bar per architecture.md §7.2 — Alerts · Checks · Schedule · Me, in that order.
// The Checks stack is labelled "Apparatus" (docs/design.md §3.3 tab name; §3.2 reserves nothing
// for "checks" as a place). The route name stays Checks so deep links and navigate() calls hold.
// All four are real stacks as of phase 7; Alerts is scoped to the self-test round trip until
// boxalarm-backend access lands for the general dispatch-received path.
export type AppTabsParamList = {
  Alerts: NavigatorScreenParams<AlertsStackParamList> | undefined;
  Checks: undefined;
  Schedule: undefined;
  // Addressable screens so a non-critical notification tap can land on Me > Inbox.
  Me: NavigatorScreenParams<MeStackParamList> | undefined;
};

const TAB_BAR_PADDING_TOP = 8;

const Tab = createBottomTabNavigator<AppTabsParamList>();

// Text glyphs, not an icon library — see components/ui/README.md (no react-native-svg link
// step to verify in this repo's CI).
const TAB_GLYPH: Record<keyof AppTabsParamList, string> = {
  Alerts: '▲',
  Checks: '■',
  Schedule: '◷',
  Me: '●',
};

export function AppTabs() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <Tab.Navigator
      initialRouteName="Alerts"
      screenOptions={({ route }) => ({
        headerShown: false,
        // The dark frame in both palettes, amber marking the current tab (shellPalette, AA-tested).
        tabBarActiveTintColor: theme.shell.accent,
        tabBarInactiveTintColor: theme.shell.fgMuted,
        tabBarStyle: {
          backgroundColor: theme.shell.bg,
          borderTopColor: theme.shell.border,
          // Glove-sized targets (N3.5): the tab row itself clears the field floor, with the
          // home-indicator inset (which the bar pads below) added on top of it.
          height: targetSize.field + TAB_BAR_PADDING_TOP + insets.bottom,
          paddingTop: TAB_BAR_PADDING_TOP,
        },
        tabBarLabelStyle: { fontSize: typeScale.caption.size, fontWeight: '600' },
        tabBarIcon: ({ color }) => (
          <Text style={{ color, fontSize: 18 }} accessible={false}>
            {TAB_GLYPH[route.name]}
          </Text>
        ),
      })}
    >
      <Tab.Screen name="Alerts" component={AlertsStack} />
      <Tab.Screen name="Checks" component={ChecksStack} options={{ title: 'Apparatus' }} />
      <Tab.Screen name="Schedule" component={ScheduleStack} />
      <Tab.Screen name="Me" component={MeStack} />
    </Tab.Navigator>
  );
}
