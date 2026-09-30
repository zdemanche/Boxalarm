import { palette, radius, spacing, touchTarget, typography } from '@boxalarm/design-tokens';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useState } from 'react';
import {
  AccessibilityInfo,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  useColorScheme,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button } from '../../components/ui';
import { useChecksRepository } from '../../features/checks/apiChecksRepository';
import type { DefectSeverity } from '../../features/checks/types';
import { capturePhoto, type CapturedPhoto } from '../../sync/photoCapture';

// docs/design.md §8.4 severity words - the same ones the check runner uses for a failed item.
const SEVERITIES: { value: DefectSeverity; label: string }[] = [
  { value: 'MINOR', label: 'Note' },
  { value: 'MAJOR', label: 'Affects service' },
  { value: 'OUT_OF_SERVICE', label: 'Out of service now' },
];

function newIdempotencyKey(): string {
  return `defect-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function DefectReportScreen() {
  const route = useRoute();
  const navigation = useNavigation();
  const apparatusId = (route.params as { apparatusId: string }).apparatusId;
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;
  const repository = useChecksRepository();
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState<DefectSeverity>('MINOR');
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [photo, setPhoto] = useState<CapturedPhoto | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  // Stable across retries of the same report, so a resend after a real failure can't create a
  // duplicate defect record server-side (same pattern as CheckRunnerScreen's idempotencyKey).
  const [idempotencyKey] = useState(newIdempotencyKey);

  const handleAddPhoto = async () => {
    setPhotoError(null);
    const result = await capturePhoto();
    if (result.status === 'captured') {
      setPhoto(result.photo);
    } else if (result.status === 'error') {
      setPhotoError(result.message);
      AccessibilityInfo.announceForAccessibility(`Photo capture failed: ${result.message}`);
    }
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await repository.submitDefect({
        apparatusId,
        description,
        severity,
        idempotencyKey,
        ...(photo ? { photoLocalUri: photo.uri, photoFileName: photo.fileName } : {}),
      });
      setSubmitted(true);
      // The confirmation replaces the whole screen, so a screen-reader user needs an explicit
      // announcement - there's no visible element left to shift focus onto naturally.
      AccessibilityInfo.announceForAccessibility('Defect reported');
    } catch {
      // A failed submission must never show the "reported" confirmation - for an
      // OUT_OF_SERVICE report especially, that would tell the crew the unit is flagged and the
      // officer alerted when neither actually happened.
      // Never the raw error text: say what happened and where the report is.
      setSubmitError(
        'The defect report could not be saved on this phone. Everything you wrote is still here. Try again.',
      );
      AccessibilityInfo.announceForAccessibility('Defect report failed to submit');
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
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
          Defect reported
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
          Report a defect
        </Text>
        <Text
          style={{
            color: tokens.foreground,
            fontSize: typography.size.sm,
            fontWeight: '600',
            marginTop: spacing.lg,
          }}
        >
          What&apos;s wrong
        </Text>
        <TextInput
          accessibilityLabel="What's wrong"
          value={description}
          onChangeText={setDescription}
          placeholder="Describe the defect"
          placeholderTextColor={tokens.foreground + '88'}
          multiline
          style={{
            marginTop: spacing.sm,
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
            fontSize: typography.size.sm,
            marginTop: spacing.lg,
            marginBottom: spacing.sm,
          }}
        >
          Severity
        </Text>
        <View
          accessibilityRole="radiogroup"
          accessibilityLabel="Severity"
          style={{ flexDirection: 'row', gap: spacing.sm }}
        >
          {SEVERITIES.map((option) => (
            <TouchableOpacity
              key={option.value}
              accessibilityRole="radio"
              accessibilityState={{ checked: severity === option.value }}
              onPress={() => setSeverity(option.value)}
              style={{
                flex: 1,
                minHeight: touchTarget.oversized.ios,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: radius.default,
                backgroundColor:
                  severity === option.value ? tokens.accent : tokens.foreground + '11',
              }}
            >
              <Text
                style={{
                  color: severity === option.value ? tokens.background : tokens.foreground,
                  fontWeight: '600',
                  fontSize: typography.size.sm,
                }}
              >
                {option.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        {severity === 'OUT_OF_SERVICE' ? (
          <Text
            accessibilityRole="alert"
            style={{
              color: tokens.error,
              fontSize: typography.size.sm,
              marginTop: spacing.lg,
            }}
          >
            This takes the unit out of service and alerts the apparatus officer.
          </Text>
        ) : null}
        <View style={{ marginTop: spacing.lg }}>
          <Button
            label={photo ? 'Retake photo' : 'Add photo'}
            variant="secondary"
            onPress={() => void handleAddPhoto()}
          />
          {photo ? (
            <Text
              style={{ color: tokens.success, fontSize: typography.size.sm, marginTop: spacing.sm }}
            >
              Photo attached: {photo.fileName}
            </Text>
          ) : null}
          {photoError ? (
            <Text
              accessibilityRole="alert"
              style={{ color: tokens.error, fontSize: typography.size.sm, marginTop: spacing.sm }}
            >
              {photoError}
            </Text>
          ) : null}
        </View>
        {submitError ? (
          <Text
            accessibilityRole="alert"
            style={{
              color: tokens.error,
              fontSize: typography.size.sm,
              marginTop: spacing.lg,
              fontWeight: '600',
            }}
          >
            {submitError}
          </Text>
        ) : null}
        <TouchableOpacity
          accessibilityRole="button"
          disabled={description.trim().length === 0 || submitting}
          accessibilityState={{ disabled: description.trim().length === 0 || submitting }}
          onPress={handleSubmit}
          style={{
            minHeight: touchTarget.baseline.ios,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: tokens.error,
            opacity: description.trim().length === 0 || submitting ? 0.5 : 1,
            borderRadius: radius.default,
            marginTop: spacing.lg,
          }}
        >
          <Text
            style={{ color: tokens.background, fontSize: typography.size.base, fontWeight: '600' }}
          >
            Submit defect report
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}
