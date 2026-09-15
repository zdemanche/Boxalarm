import { palette, touchTarget, typography } from '@boxalarm/design-tokens';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useColorScheme } from 'react-native';
import { PlaceholderScreen } from '../screens/PlaceholderScreen';
import { ChecksStack } from './ChecksStack';
import { MeStack } from './MeStack';

// Bottom tab bar per architecture.md §7.2 — Alerts · Checks · Schedule · Me, in that order.
// Alerts/Schedule are placeholders until their own phase (6-7) builds the real stack; Checks
// (phase 5) and Me (phase 4) are real stacks.
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

function SchedulePlaceholder() {
  return <PlaceholderScreen label="Schedule stack coming in phase 6" />;
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
      <Tab.Screen name="Schedule" component={SchedulePlaceholder} />
      <Tab.Screen name="Me" component={MeStack} />
    </Tab.Navigator>
  );
}
