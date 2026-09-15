import { palette, touchTarget, typography } from '@boxalarm/design-tokens';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useColorScheme } from 'react-native';
import { PlaceholderScreen } from '../screens/PlaceholderScreen';
import { ChecksStack } from './ChecksStack';
import { MeStack } from './MeStack';
import { ScheduleStack } from './ScheduleStack';

// Bottom tab bar per architecture.md §7.2 — Alerts · Checks · Schedule · Me, in that order.
// Alerts is a placeholder until phase 7 builds the real stack (self-test scope only); Checks
// (5), Schedule (6), and Me (4) are real stacks.
export type AppTabsParamList = {
  Alerts: undefined;
  Checks: undefined;
  Schedule: undefined;
  Me: undefined;
};

const Tab = createBottomTabNavigator<AppTabsParamList>();

function AlertsPlaceholder() {
  return <PlaceholderScreen label="Alerts stack coming in phase 7" />;
}

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
          height: touchTarget.baseline.ios + 24,
          paddingTop: 8,
        },
        tabBarLabelStyle: { fontSize: typography.size.xs },
      }}
    >
      <Tab.Screen name="Alerts" component={AlertsPlaceholder} />
      <Tab.Screen name="Checks" component={ChecksStack} />
      <Tab.Screen name="Schedule" component={ScheduleStack} />
      <Tab.Screen name="Me" component={MeStack} />
    </Tab.Navigator>
  );
}
