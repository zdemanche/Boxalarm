import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { AlertDetailScreen } from '../screens/alerts/AlertDetailScreen';
import { AlertsHomeScreen } from '../screens/alerts/AlertsHomeScreen';
import { ManualDispatchEntryScreen } from '../screens/alerts/ManualDispatchEntryScreen';
import { RidingBoardScreen } from '../screens/alerts/RidingBoardScreen';
import { RosterScreen } from '../screens/alerts/RosterScreen';

// Alerts home, manual entry, alert detail + response, live roster, riding board -
// architecture.md §7.2 AlertsStack.
export type AlertsStackParamList = {
  AlertsHome: undefined;
  ManualEntry: undefined;
  AlertDetail: { dispatchId: string };
  Roster: { dispatchId: string };
  RidingBoard: { dispatchId: string };
};

const Stack = createNativeStackNavigator<AlertsStackParamList>();

export function AlertsStack() {
  return (
    <Stack.Navigator>
      <Stack.Screen name="AlertsHome" component={AlertsHomeScreen} options={{ title: 'Alerts' }} />
      <Stack.Screen
        name="ManualEntry"
        component={ManualDispatchEntryScreen}
        options={{ title: 'Manual entry' }}
      />
      <Stack.Screen name="AlertDetail" component={AlertDetailScreen} options={{ title: 'Alert' }} />
      <Stack.Screen name="Roster" component={RosterScreen} options={{ title: 'Roster' }} />
      <Stack.Screen
        name="RidingBoard"
        component={RidingBoardScreen}
        options={{ title: 'Riding board' }}
      />
    </Stack.Navigator>
  );
}
