import { palette, touchTarget, typography } from '@boxalarm/design-tokens';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useColorScheme } from 'react-native';
import { AlertsStack } from './AlertsStack';
import { ChecksStack } from './ChecksStack';
import { MeStack } from './MeStack';
import { ScheduleStack } from './ScheduleStack';

// Bottom tab bar per architecture.md §7.2 — Alerts · Checks · Schedule · Me, in that order.
// All four are real stacks as of phase 7; Alerts is scoped to the self-test round trip until
// boxalarm-backend access lands for the general dispatch-received path.
export type AppTabsParamList = {
  Alerts: undefined;
  Checks: undefined;
  Schedule: undefined;
  Me: undefined;
};

const Tab = createBottomTabNavigator<AppTabsParamList>();

export function AppTabs() {
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;

  return (
    <Tab.Navigator
      initialRouteName="Alerts"
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: tokens.accent,
        tabBarInactiveTintColor: tokens.foreground,
        tabBarStyle: {
          backgroundColor: tokens.background,
          // Glove-sized targets (N3.5): taller bar than the platform default so each tab's
          // hit area clears the 44/48pt baseline with room to spare.
          height: touchTarget.baseline.ios + 24,
          paddingTop: 8,
        },
        tabBarLabelStyle: { fontSize: typography.size.xs },
      }}
    >
      <Tab.Screen name="Alerts" component={AlertsStack} />
      <Tab.Screen name="Checks" component={ChecksStack} />
      <Tab.Screen name="Schedule" component={ScheduleStack} />
      <Tab.Screen name="Me" component={MeStack} />
    </Tab.Navigator>
  );
}
