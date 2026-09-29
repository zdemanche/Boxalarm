import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { Role } from '../auth/AuthContext';
import type { AlertPayload } from '../features/alerts/alertPayload';
import { AlertDetailScreen } from '../screens/alerts/AlertDetailScreen';
import { AlertsHomeScreen } from '../screens/alerts/AlertsHomeScreen';
import { ManualDispatchEntryScreen } from '../screens/alerts/ManualDispatchEntryScreen';
import { RidingBoardScreen } from '../screens/alerts/RidingBoardScreen';
import { RosterScreen } from '../screens/alerts/RosterScreen';
import { RequireRole } from './RequireRole';

// Matches routeTable.ts's '/alerts/roster' entry on web (OFFICER/CHIEF) and
// AlertsHomeScreen's own canEnterManually check - manual dispatch entry and riding-board seat
// assignment are officer/chief actions.
const OFFICER_CHIEF_ROLES: readonly Role[] = ['OFFICER', 'CHIEF'];

// Alerts home, manual entry, alert detail + response, live roster, riding board -
// architecture.md §7.2 AlertsStack.
export type AlertsStackParamList = {
  AlertsHome: undefined;
  ManualEntry: undefined;
  /** `payload` is what the page itself carried, so the screen paints before any fetch. */
  AlertDetail: { dispatchId: string; payload?: AlertPayload };
  Roster: { dispatchId: string };
  RidingBoard: { dispatchId: string };
};

const Stack = createNativeStackNavigator<AlertsStackParamList>();

export function AlertsStack() {
  return (
    <Stack.Navigator>
      <Stack.Screen name="AlertsHome" component={AlertsHomeScreen} options={{ title: 'Alerts' }} />
      <Stack.Screen name="ManualEntry" options={{ title: 'Manual entry' }}>
        {() => (
          <RequireRole roles={OFFICER_CHIEF_ROLES}>
            <ManualDispatchEntryScreen />
          </RequireRole>
        )}
      </Stack.Screen>
      <Stack.Screen name="AlertDetail" component={AlertDetailScreen} options={{ title: 'Alert' }} />
      <Stack.Screen name="Roster" component={RosterScreen} options={{ title: 'Roster' }} />
      <Stack.Screen name="RidingBoard" options={{ title: 'Riding board' }}>
        {() => (
          <RequireRole roles={OFFICER_CHIEF_ROLES}>
            <RidingBoardScreen />
          </RequireRole>
        )}
      </Stack.Screen>
    </Stack.Navigator>
  );
}
