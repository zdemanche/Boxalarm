import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { AvailabilityScreen } from '../screens/schedule/AvailabilityScreen';
import { ShiftBoardScreen } from '../screens/schedule/ShiftBoardScreen';
import { ShiftDetailScreen } from '../screens/schedule/ShiftDetailScreen';
import { TrainingEventsScreen } from '../screens/schedule/TrainingEventsScreen';

// Shift board, shift detail/claim, availability, training events - architecture.md §7.2
// ScheduleStack.
export type ScheduleStackParamList = {
  ShiftBoard: undefined;
  ShiftDetail: { shiftId: string };
  Availability: undefined;
  TrainingEvents: undefined;
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
      <Stack.Screen
        name="TrainingEvents"
        component={TrainingEventsScreen}
        options={{ title: 'Training events' }}
      />
    </Stack.Navigator>
  );
}
