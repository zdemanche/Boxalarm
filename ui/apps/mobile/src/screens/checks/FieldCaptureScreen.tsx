import { palette, radius, spacing, touchTarget, typography } from '@boxalarm/design-tokens';
import { useNavigation } from '@react-navigation/native';
import { useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  useColorScheme,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { mockSyncRepository } from '../../features/sync/mockSyncRepository';

export function FieldCaptureScreen() {
  const navigation = useNavigation();
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;
  const [occupancyId, setOccupancyId] = useState('');
  const [inspectionId, setInspectionId] = useState('');
  const [notes, setNotes] = useState('');
  const [savedOffline, setSavedOffline] = useState(false);
  // Stable per-attempt idempotency key (F7.7 / N3.4): generated once and reused across retries
  // of this same capture so a drain-time re-fan-out never double-submits.
  const idempotencyKeyRef = useRef<string>(`fc-${Date.now()}-${Math.round(Math.random() * 1e9)}`);

  const handleSubmit = () => {
    void mockSyncRepository.enqueue(
      'FIELD_CAPTURE',
      `Field capture — ${occupancyId || 'occupancy'}`,
      idempotencyKeyRef.current,
    );
    setSavedOffline(true);
    AccessibilityInfo.announceForAccessibility(
      'Saved offline. Will sync when you have a connection.',
    );
  };

  if (savedOffline) {
    return (
      <SafeAreaView
        style={{
          flex: 1,
          backgroundColor: tokens.background,
          alignItems: 'center',
          justifyContent: 'center',
          padding: spacing.lg,
        }}
      >
        <Text
          accessibilityRole="header"
          style={{ color: tokens.success, fontSize: typography.size.lg, fontWeight: '700' }}
        >
          Saved offline, will sync
        </Text>
        <TouchableOpacity
          accessibilityRole="button"
          onPress={() => navigation.goBack()}
          style={{
            marginTop: spacing.lg,
            minHeight: touchTarget.baseline.ios,
            justifyContent: 'center',
          }}
        >
          <Text style={{ color: tokens.accent, fontSize: typography.size.base }}>Back</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg }}>
        <Text
          accessibilityRole="header"
          style={{ color: tokens.foreground, fontSize: typography.size.lg, fontWeight: '700' }}
        >
          Field capture
        </Text>
        <Text
          style={{ color: tokens.foreground, fontSize: typography.size.sm, marginTop: spacing.lg }}
        >
          Occupancy ID
        </Text>
        <TextInput
          accessibilityLabel="Occupancy ID"
          value={occupancyId}
          onChangeText={setOccupancyId}
          placeholderTextColor={tokens.foreground + '88'}
          style={{
            marginTop: spacing.xs,
            minHeight: touchTarget.baseline.ios,
            borderWidth: 1,
            borderColor: tokens.foreground + '33',
            borderRadius: radius.default,
            paddingHorizontal: spacing.md,
            color: tokens.foreground,
            fontSize: typography.size.base,
          }}
        />
        <Text
          style={{ color: tokens.foreground, fontSize: typography.size.sm, marginTop: spacing.lg }}
        >
          Inspection ID
        </Text>
        <TextInput
          accessibilityLabel="Inspection ID"
          value={inspectionId}
          onChangeText={setInspectionId}
          placeholderTextColor={tokens.foreground + '88'}
          style={{
            marginTop: spacing.xs,
            minHeight: touchTarget.baseline.ios,
            borderWidth: 1,
            borderColor: tokens.foreground + '33',
            borderRadius: radius.default,
            paddingHorizontal: spacing.md,
            color: tokens.foreground,
            fontSize: typography.size.base,
          }}
        />
        <Text
          accessibilityLabel="Notes"
          style={{ color: tokens.foreground, fontSize: typography.size.sm, marginTop: spacing.lg }}
        >
          Notes (optional)
        </Text>
        <TextInput
          value={notes}
          onChangeText={setNotes}
          multiline
          placeholderTextColor={tokens.foreground + '88'}
          style={{
            marginTop: spacing.xs,
            minHeight: 100,
            borderWidth: 1,
            borderColor: tokens.foreground + '33',
            borderRadius: radius.default,
            padding: spacing.md,
            color: tokens.foreground,
            fontSize: typography.size.base,
            textAlignVertical: 'top',
          }}
        />
        <Text
          style={{
            color: tokens.foreground,
            opacity: 0.6,
            fontSize: typography.size.sm,
            marginTop: spacing.lg,
          }}
        >
          Photo attachment is not yet connected.
        </Text>
        <TouchableOpacity
          accessibilityRole="button"
          disabled={occupancyId.trim().length === 0 || inspectionId.trim().length === 0}
          onPress={handleSubmit}
          style={{
            minHeight: touchTarget.baseline.ios,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: tokens.accent,
            opacity: occupancyId.trim().length === 0 || inspectionId.trim().length === 0 ? 0.5 : 1,
            borderRadius: radius.default,
            marginTop: spacing.lg,
          }}
        >
          <Text
            style={{ color: tokens.background, fontSize: typography.size.base, fontWeight: '600' }}
          >
            Submit capture
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}
