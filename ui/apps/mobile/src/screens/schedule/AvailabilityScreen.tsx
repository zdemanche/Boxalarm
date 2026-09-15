import { palette, radius, spacing, touchTarget, typography } from '@boxalarm/design-tokens';
import { useState } from 'react';
import { Text, TextInput, TouchableOpacity, useColorScheme } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { mockScheduleRepository } from '../../features/schedule/mockScheduleRepository';

// F2.5: planned unavailability that suppresses alerting. Date-range picking is out of this
// phase's scope (no calendar component chosen yet) - defaults to today through a week out,
// which is enough to exercise the real submit/confirm flow.
function defaultStart(): string {
  return new Date().toISOString();
}

function defaultEnd(): string {
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
}

export function AvailabilityScreen() {
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);

  const handleSubmit = () => {
    void mockScheduleRepository.markUnavailable(defaultStart(), defaultEnd(), reason || undefined);
    setConfirmed(true);
  };

  if (confirmed) {
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
          Marked unavailable
        </Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background, padding: spacing.lg }}>
      <Text
        accessibilityRole="header"
        style={{ color: tokens.foreground, fontSize: typography.size.lg, fontWeight: '700' }}
      >
        Mark unavailable
      </Text>
      <Text
        style={{
          color: tokens.foreground,
          opacity: 0.7,
          fontSize: typography.size.sm,
          marginTop: spacing.sm,
        }}
      >
        Suppresses alert paging for the next 7 days. This does not cancel any shift you've
        already claimed.
      </Text>
      <TextInput
        value={reason}
        onChangeText={setReason}
        placeholder="Reason (optional)"
        placeholderTextColor={tokens.foreground + '88'}
        style={{
          marginTop: spacing.lg,
          minHeight: touchTarget.baseline.ios,
          borderWidth: 1,
          borderColor: tokens.foreground + '33',
          borderRadius: radius.default,
          paddingHorizontal: spacing.md,
          color: tokens.foreground,
          fontSize: typography.size.base,
        }}
      />
      <TouchableOpacity
        accessibilityRole="button"
        onPress={handleSubmit}
        style={{
          minHeight: touchTarget.baseline.ios,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: tokens.accent,
          borderRadius: radius.default,
          marginTop: spacing.lg,
        }}
      >
        <Text
          style={{ color: tokens.background, fontSize: typography.size.base, fontWeight: '600' }}
        >
          Mark unavailable
        </Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}
