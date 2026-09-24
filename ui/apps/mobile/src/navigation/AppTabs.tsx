import { targetSize, typeScale } from '@boxalarm/design-tokens';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import type { NavigatorScreenParams } from '@react-navigation/native';
import { Text } from 'react-native';
import { useTheme } from '../components/ui/theme';
import { AlertsStack, type AlertsStackParamList } from './AlertsStack';
import { ChecksStack } from './ChecksStack';
import { MeStack } from './MeStack';
import { ScheduleStack } from './ScheduleStack';

// Bottom tab bar per architecture.md §7.2 — Alerts · Checks · Schedule · Me, in that order.
// All four are real stacks as of phase 7; Alerts is scoped to the self-test round trip until
// boxalarm-backend access lands for the general dispatch-received path.
export type AppTabsParamList = {
  Alerts: NavigatorScreenParams<AlertsStackParamList> | undefined;
  Checks: undefined;
  Schedule: undefined;
  Me: undefined;
};

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

  return (
    <Tab.Navigator
      initialRouteName="Alerts"
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: theme.fg,
        tabBarInactiveTintColor: theme.fgMuted,
        tabBarStyle: {
          backgroundColor: theme.surface,
          borderTopColor: theme.borderDecorative,
          // Glove-sized targets (N3.5): taller bar than the platform default so each tab's
          // hit area clears the field floor with room to spare.
          height: targetSize.field + 24,
          paddingTop: 8,
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
      <Tab.Screen name="Checks" component={ChecksStack} />
      <Tab.Screen name="Schedule" component={ScheduleStack} />
      <Tab.Screen name="Me" component={MeStack} />
    </Tab.Navigator>
  );
}
