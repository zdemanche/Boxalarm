import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { AvailabilityScreen } from '../screens/schedule/AvailabilityScreen';
import { ShiftBoardScreen } from '../screens/schedule/ShiftBoardScreen';
import { ShiftDetailScreen } from '../screens/schedule/ShiftDetailScreen';

// Shift board, shift detail/claim, availability - architecture.md §7.2 ScheduleStack.
export type ScheduleStackParamList = {
  ShiftBoard: undefined;
  ShiftDetail: { shiftId: string };
  Availability: undefined;
};

const Stack = createNativeStackNavigator<ScheduleStackParamList>();

export function ScheduleStack() {
  return (
    <Stack.Navigator>
      <Stack.Screen
        name="ShiftBoard"
        component={ShiftBoardScreen}
        options={{ title: 'Schedule' }}
      />
      <Stack.Screen name="ShiftDetail" component={ShiftDetailScreen} options={{ title: 'Shift' }} />
      <Stack.Screen
        name="Availability"
        component={AvailabilityScreen}
        options={{ title: 'Availability' }}
      />
    </Stack.Navigator>
  );
}
