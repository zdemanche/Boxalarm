import { palette, radius, spacing, touchTarget, typography } from '@boxalarm/design-tokens';
import { useNavigation, type NavigationProp } from '@react-navigation/native';
import { useEffect, useState } from 'react';
import {
  AccessibilityInfo,
  Platform,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  useColorScheme,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAlertsRepository } from '../../features/alerts/apiAlertsRepository';
import type { FieldError, ManualDispatchInput } from '../../features/alerts/types';
import { ApiError } from '../../lib/apiClient';
import type { AlertsStackParamList } from '../../navigation/AlertsStack';

const OTHER_TOWN = '__other__';
// Matches the backend's MAX_LOCALITY_TOWN_LENGTH (a longer town is dropped server-side).
const MAX_TOWN_LENGTH = 80;
const LOCALITY_LABEL = 'Town / village (required)';
// Platform minimum touch target for the locality controls: 44pt iOS, 48dp Android (m8).
const localityTarget = () =>
  Platform.OS === 'android' ? touchTarget.baseline.android : touchTarget.baseline.ios;

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
  // R3-A: the required "where is this?" choice - a home town/village, or "Other town" typed
  // in. It only decides whether a pre-plan can be shown as this building's; if the home list
  // cannot be loaded the choice is just "Other town", never a blocked form.
  const [homeTowns, setHomeTowns] = useState<string[]>([]);
  const [localityChoice, setLocalityChoice] = useState<string | null>(null);
  const [otherTown, setOtherTown] = useState('');

  useEffect(() => {
    let active = true;
    repository
      .getHomeLocality()
      .then((home) => {
        if (active) setHomeTowns(home.towns);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [repository]);

  const errorFor = (field: string) => fieldErrors.find((e) => e.field === field)?.message;
  const localityError =
    errorFor('locality') ?? errorFor('locality.town') ?? errorFor('locality.choice');

  // Android announces the error through its live region; iOS has no live regions, so announce
  // it explicitly (m8).
  useEffect(() => {
    if (localityError && Platform.OS === 'ios') {
      AccessibilityInfo.announceForAccessibility(localityError);
    }
  }, [localityError]);

  const submit = async () => {
    setFieldErrors([]);
    setFormError(null);
    const locality =
      localityChoice === OTHER_TOWN
        ? { town: otherTown.trim(), choice: 'OTHER' as const }
        : { town: localityChoice ?? '', choice: 'HOME' as const };
    if (locality.town.length === 0) {
      setFieldErrors([{ field: 'locality', message: 'Choose the town or village.' }]);
      return;
    }
    setSubmitting(true);
    try {
      const input: ManualDispatchInput = {
        ...form,
        locality,
        unitsRequested: unitsText
          .split(',')
          .map((u) => u.trim())
          .filter(Boolean),
      };
      const { dispatchId } = await repository.submitManualDispatch(input);
      // M1: this screen stays mounted under the pushed Roster, so a stale town choice would
      // carry into the next (possibly mutual-aid) call and verify the wrong town's plan.
      // Reset everything, like the web form does on success.
      setForm(EMPTY_FORM);
      setUnitsText('');
      setLocalityChoice(null);
      setOtherTown('');
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
    key: keyof Omit<ManualDispatchInput, 'unitsRequested' | 'locality'>,
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

        <View
          style={{ marginTop: spacing.md }}
          testID="locality-group"
          accessibilityRole="radiogroup"
          accessibilityLabel={LOCALITY_LABEL}
          accessibilityLabelledBy="locality-label"
        >
          <Text
            nativeID="locality-label"
            style={{ color: tokens.foreground, fontSize: typography.size.sm, fontWeight: '600' }}
          >
            {LOCALITY_LABEL}
          </Text>
          {/* "Other town…" comes first so the home towns loading in below it can never move it
              under a finger mid-tap (m8). */}
          {[OTHER_TOWN, ...homeTowns].map((choice) => {
            const selected = localityChoice === choice;
            const label = choice === OTHER_TOWN ? 'Other town…' : choice;
            return (
              <View key={choice}>
                <TouchableOpacity
                  accessibilityRole="radio"
                  accessibilityLabel={label}
                  accessibilityState={{ checked: selected }}
                  onPress={() => setLocalityChoice(choice)}
                  style={{
                    minHeight: localityTarget(),
                    justifyContent: 'center',
                    paddingHorizontal: spacing.md,
                    marginTop: spacing.xs,
                    borderWidth: selected ? 2 : 1,
                    borderColor: selected ? tokens.accent : tokens.foreground + '33',
                    borderRadius: radius.default,
                  }}
                >
                  <Text style={{ color: tokens.foreground, fontSize: typography.size.base }}>
                    {selected ? '● ' : '○ '}
                    {label}
                  </Text>
                </TouchableOpacity>
                {choice === OTHER_TOWN && selected ? (
                  <TextInput
                    accessibilityLabel="Other town name"
                    maxLength={MAX_TOWN_LENGTH}
                    value={otherTown}
                    onChangeText={setOtherTown}
                    style={{
                      minHeight: localityTarget(),
                      borderWidth: 1,
                      borderColor: tokens.foreground + '33',
                      borderRadius: radius.default,
                      paddingHorizontal: spacing.md,
                      color: tokens.foreground,
                      fontSize: typography.size.base,
                      marginTop: spacing.xs,
                    }}
                  />
                ) : null}
              </View>
            );
          })}
          {localityError ? (
            <Text
              accessibilityLiveRegion="polite"
              style={{ color: tokens.error, fontSize: typography.size.sm, marginTop: 2 }}
            >
              {localityError}
            </Text>
          ) : null}
        </View>

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
