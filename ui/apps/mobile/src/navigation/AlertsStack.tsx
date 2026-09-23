import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { AlertDetailScreen } from '../screens/alerts/AlertDetailScreen';
import { AlertsHomeScreen } from '../screens/alerts/AlertsHomeScreen';
import { RosterScreen } from '../screens/alerts/RosterScreen';

// Self-test entry, alert detail + response, live roster - architecture.md §7.2 AlertsStack.
// Phase 7 scope: self-test only. The general dispatch-received path reuses these same screens
// (AlertsRepository already models a real DispatchAlert/RosterEntry, not a test-only shape) so
// it activates without a UI rewrite once boxalarm-backend access lands.
export type AlertsStackParamList = {
  AlertsHome: undefined;
  AlertDetail: { dispatchId: string };
  Roster: { dispatchId: string };
};

const Stack = createNativeStackNavigator<AlertsStackParamList>();

export function AlertsStack() {
  return (
    <Stack.Navigator>
      <Stack.Screen name="AlertsHome" component={AlertsHomeScreen} options={{ title: 'Alerts' }} />
      <Stack.Screen name="AlertDetail" component={AlertDetailScreen} options={{ title: 'Alert' }} />
      <Stack.Screen name="Roster" component={RosterScreen} options={{ title: 'Roster' }} />
    </Stack.Navigator>
  );
}
