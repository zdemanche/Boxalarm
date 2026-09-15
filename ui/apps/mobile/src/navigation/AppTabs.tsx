import { palette, touchTarget, typography } from '@boxalarm/design-tokens';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useColorScheme } from 'react-native';
import { PlaceholderScreen } from '../screens/PlaceholderScreen';

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

function ChecksPlaceholder() {
  return <PlaceholderScreen label="Checks stack coming in phase 5" />;
}

function SchedulePlaceholder() {
  return <PlaceholderScreen label="Schedule stack coming in phase 6" />;
}

function MePlaceholder() {
  return <PlaceholderScreen label="Me stack coming in phase 4" />;
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
      <Tab.Screen name="Checks" component={ChecksPlaceholder} />
      <Tab.Screen name="Schedule" component={SchedulePlaceholder} />
      <Tab.Screen name="Me" component={MePlaceholder} />
    </Tab.Navigator>
  );
}
