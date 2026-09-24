import { palette, radius, spacing, touchTarget, typography } from '@boxalarm/design-tokens';
import { useNavigation, type NavigationProp } from '@react-navigation/native';
import { useState } from 'react';
import { ScrollView, Text, TextInput, TouchableOpacity, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAlertsRepository } from '../../features/alerts/apiAlertsRepository';
import type { FieldError, ManualDispatchInput } from '../../features/alerts/types';
import { ApiError } from '../../lib/apiClient';
import type { AlertsStackParamList } from '../../navigation/AlertsStack';

const EMPTY_FORM: ManualDispatchInput = {
  incidentType: '',
  address: '',
  crossStreets: '',
  unitsRequested: [],
  narrative: '',
  externalDispatchId: '',
};

// E1-S1-UI: the N1.8 degraded-mode fallback - officer keys in a dispatch by hand when no CAD
// feed exists or it is down. Fields match dispatchIngressPort.normalizeManualEntry exactly.
export function ManualDispatchEntryScreen() {
  const navigation = useNavigation<NavigationProp<AlertsStackParamList>>();
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;
  const repository = useAlertsRepository();
  const [form, setForm] = useState<ManualDispatchInput>(EMPTY_FORM);
  const [unitsText, setUnitsText] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const errorFor = (field: string) => fieldErrors.find((e) => e.field === field)?.message;

  const submit = async () => {
    setSubmitting(true);
    setFieldErrors([]);
    setFormError(null);
    try {
      const input: ManualDispatchInput = {
        ...form,
        unitsRequested: unitsText
          .split(',')
          .map((u) => u.trim())
          .filter(Boolean),
      };
      const { dispatchId } = await repository.submitManualDispatch(input);
      navigation.navigate('Roster', { dispatchId });
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.problem.status === 409) {
          setFormError('This dispatch was already entered. It has not been resubmitted.');
        } else if (Array.isArray((error.problem as { errors?: FieldError[] }).errors)) {
          setFieldErrors((error.problem as unknown as { errors: FieldError[] }).errors);
        } else {
          setFormError(error.problem.detail ?? error.problem.title);
        }
      } else {
        setFormError('Could not submit the dispatch. Try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const field = (
    label: string,
    key: keyof Omit<ManualDispatchInput, 'unitsRequested'>,
    options: { multiline?: boolean } = {},
  ) => (
    <View style={{ marginTop: spacing.md }}>
      <Text
        nativeID={`${key}-label`}
        style={{ color: tokens.foreground, fontSize: typography.size.sm, fontWeight: '600' }}
      >
        {label}
      </Text>
      <TextInput
        accessibilityLabel={label}
        accessibilityLabelledBy={`${key}-label`}
        value={form[key]}
        onChangeText={(text) => setForm((prev) => ({ ...prev, [key]: text }))}
        multiline={options.multiline}
        style={{
          minHeight: options.multiline ? 80 : touchTarget.baseline.ios,
          borderWidth: 1,
          borderColor: errorFor(key) ? tokens.error : tokens.foreground + '33',
          borderRadius: radius.default,
          paddingHorizontal: spacing.md,
          paddingVertical: options.multiline ? spacing.sm : 0,
          color: tokens.foreground,
          fontSize: typography.size.base,
          marginTop: spacing.xs,
        }}
      />
      {errorFor(key) ? (
        <Text
          accessibilityLiveRegion="polite"
          style={{ color: tokens.error, fontSize: typography.size.sm, marginTop: 2 }}
        >
          {errorFor(key)}
        </Text>
      ) : null}
    </View>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg }}>
        <Text
          accessibilityRole="header"
          style={{ color: tokens.foreground, fontSize: typography.size.lg, fontWeight: '700' }}
        >
          Enter dispatch manually
        </Text>

        {field('Incident type', 'incidentType')}
        {field('Address', 'address')}
        {field('Cross streets', 'crossStreets')}

        <View style={{ marginTop: spacing.md }}>
          <Text
            nativeID="units-label"
            style={{ color: tokens.foreground, fontSize: typography.size.sm, fontWeight: '600' }}
          >
            Units requested (comma separated, optional)
          </Text>
          <TextInput
            accessibilityLabel="Units requested"
            accessibilityLabelledBy="units-label"
            value={unitsText}
            onChangeText={setUnitsText}
            style={{
              minHeight: touchTarget.baseline.ios,
              borderWidth: 1,
              borderColor: tokens.foreground + '33',
              borderRadius: radius.default,
              paddingHorizontal: spacing.md,
              color: tokens.foreground,
              fontSize: typography.size.base,
              marginTop: spacing.xs,
            }}
          />
        </View>

        {field('Narrative', 'narrative', { multiline: true })}
        {field('Operator-entered reference', 'externalDispatchId')}

        {formError ? (
          <Text
            accessibilityRole="alert"
            style={{ color: tokens.error, fontSize: typography.size.base, marginTop: spacing.md }}
          >
            {formError}
          </Text>
        ) : null}

        <TouchableOpacity
          accessibilityRole="button"
          disabled={submitting}
          onPress={() => void submit()}
          style={{
            marginTop: spacing.lg,
            minHeight: touchTarget.oversized.ios,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: tokens.accent,
            borderRadius: radius.default,
            opacity: submitting ? 0.6 : 1,
          }}
        >
          <Text
            style={{ color: tokens.background, fontSize: typography.size.base, fontWeight: '600' }}
          >
            {submitting ? 'Submitting…' : 'Submit dispatch'}
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}
