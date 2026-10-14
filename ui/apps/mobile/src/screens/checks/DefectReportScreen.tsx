import { radiusScale, spacing, typeScale } from '@boxalarm/design-tokens';
import { useNavigation, useRoute, type NavigationProp } from '@react-navigation/native';
import { useState } from 'react';
import { AccessibilityInfo, Text, TextInput, View } from 'react-native';
import { Button, Card, Screen, useTheme } from '../../components/ui';
import { useChecksRepository } from '../../features/checks/apiChecksRepository';
import type { DefectSeverity } from '../../features/checks/types';
import type { ChecksStackParamList } from '../../navigation/ChecksStack';
import { capturePhoto, type CapturedPhoto } from '../../sync/photoCapture';
import { ROW_TEXT_SIZE } from './fieldText';
import { RadioOption } from './RadioOption';

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
  const navigation = useNavigation<NavigationProp<ChecksStackParamList>>();
  const apparatusId = (route.params as { apparatusId: string }).apparatusId;
  const theme = useTheme();
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
      <Screen>
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
            <Text
              accessible={false}
              style={{ color: theme.status.ok, fontSize: typeScale.title.size, fontWeight: '700' }}
            >
              ✓
            </Text>
            <Text
              accessibilityRole="header"
              style={{ color: theme.fg, fontSize: typeScale.title.size, fontWeight: '700' }}
            >
              Defect reported
            </Text>
          </View>
          <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>
            {apparatusId} · {SEVERITIES.find((option) => option.value === severity)?.label}
          </Text>
          {severity === 'OUT_OF_SERVICE' ? (
            <Text style={{ color: theme.fg, fontSize: typeScale.body.size }}>
              This report asks for {apparatusId} to be taken out of service.
            </Text>
          ) : null}
        </Card>
        <Button label="Back" fullWidth onPress={() => navigation.goBack()} />
      </Screen>
    );
  }

  const outOfService = severity === 'OUT_OF_SERVICE';
  const sectionLabel = { color: theme.fg, fontSize: ROW_TEXT_SIZE, fontWeight: '600' } as const;

  return (
    <Screen>
      <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>For {apparatusId}</Text>
      <Card>
        <Text style={sectionLabel}>What&apos;s wrong</Text>
        <TextInput
          accessibilityLabel="What's wrong"
          value={description}
          onChangeText={setDescription}
          placeholder="Describe the defect"
          placeholderTextColor={theme.fgFaint}
          multiline
          style={{
            minHeight: 100,
            borderWidth: 1,
            borderColor: theme.border,
            borderRadius: radiusScale.md,
            padding: spacing.md,
            color: theme.fg,
            backgroundColor: theme.surface,
            fontSize: typeScale.body.size,
            textAlignVertical: 'top',
          }}
        />
      </Card>
      <Card>
        <Text style={sectionLabel}>Severity</Text>
        <View
          accessibilityRole="radiogroup"
          accessibilityLabel="Severity"
          style={{ gap: spacing.sm }}
        >
          {SEVERITIES.map((option) => (
            <RadioOption
              key={option.value}
              label={option.label}
              selected={severity === option.value}
              onPress={() => setSeverity(option.value)}
            />
          ))}
        </View>
        {outOfService ? (
          <Text
            accessibilityRole="alert"
            style={{ color: theme.status.danger, fontSize: typeScale.body.size, fontWeight: '600' }}
          >
            This takes the unit out of service and alerts the apparatus officer.
          </Text>
        ) : null}
      </Card>
      <Card>
        <Button
          label={photo ? 'Retake photo' : 'Add photo'}
          variant="secondary"
          onPress={() => void handleAddPhoto()}
        />
        {photo ? (
          <Text style={{ color: theme.status.ok, fontSize: typeScale.body.size }}>
            Photo attached: {photo.fileName}
          </Text>
        ) : null}
        {photoError ? (
          <Text
            accessibilityRole="alert"
            style={{ color: theme.status.danger, fontSize: typeScale.body.size }}
          >
            {photoError}
          </Text>
        ) : null}
      </Card>
      {submitError ? (
        <Card>
          <Text
            accessibilityRole="alert"
            style={{ color: theme.status.danger, fontSize: typeScale.body.size, fontWeight: '600' }}
          >
            {submitError}
          </Text>
        </Card>
      ) : null}
      {/* Out of service now is an alarm action, so it is red; any other report is the screen's
          amber main action. */}
      <Button
        label="Submit defect report"
        variant={outOfService ? 'danger' : 'primary'}
        fullWidth
        disabled={description.trim().length === 0}
        loading={submitting}
        onPress={() => void handleSubmit()}
      />
    </Screen>
  );
}
