import { radiusScale, spacing, targetSize, typeScale } from '@boxalarm/design-tokens';
import { useNavigation, type NavigationProp } from '@react-navigation/native';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, Platform, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Button, Card, Screen, useTheme } from '../../components/ui';
import { useAlertsRepository } from '../../features/alerts/apiAlertsRepository';
import type { FieldError, ManualDispatchInput } from '../../features/alerts/types';
import { ApiError } from '../../lib/apiClient';
import type { AlertsStackParamList } from '../../navigation/AlertsStack';
import { Notice, noticeText } from './alertsUi';

const OTHER_TOWN = '__other__';
// Matches the backend's MAX_LOCALITY_TOWN_LENGTH (a longer town is dropped server-side).
const MAX_TOWN_LENGTH = 80;
const LOCALITY_LABEL = 'Town / village (required)';
// The field floor (56dp, design.md §1) - above the 44pt / 48dp platform minimum m8 asked for.
const FIELD_TARGET = targetSize.field;
/** Field body text (design.md §1: body 17 on the field surface). */
const INPUT_TEXT = 17;

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
  const theme = useTheme();
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

  const submit = async () => {
    setFieldErrors([]);
    setFormError(null);
    const locality =
      localityChoice === OTHER_TOWN
        ? { town: otherTown.trim(), choice: 'OTHER' as const }
        : { town: localityChoice ?? '', choice: 'HOME' as const };
    if (locality.town.length === 0) {
      const message = 'Choose the town or village.';
      setFieldErrors([{ field: 'locality', message }]);
      // Android announces it through the live region; iOS has none, so announce it on every
      // failed submit, repeated ones included (m8, round-4b S2).
      if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(message);
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

  const labelStyle = {
    color: theme.fg,
    fontSize: typeScale.body.size,
    fontWeight: '600' as const,
  };
  const inputStyle = (invalid: boolean, multiline = false) => ({
    minHeight: multiline ? 96 : FIELD_TARGET,
    borderWidth: invalid ? 2 : 1,
    borderColor: invalid ? theme.status.danger : theme.border,
    borderRadius: radiusScale.md,
    backgroundColor: theme.surface,
    paddingHorizontal: spacing.md,
    paddingVertical: multiline ? spacing.sm : 0,
    color: theme.fg,
    fontSize: INPUT_TEXT,
    marginTop: spacing.xs,
  });
  const errorStyle = {
    color: theme.status.danger,
    fontSize: typeScale.body.size,
    fontWeight: '600' as const,
    marginTop: spacing.xs,
  };

  const field = (
    label: string,
    key: keyof Omit<ManualDispatchInput, 'unitsRequested' | 'locality'>,
    options: { multiline?: boolean } = {},
  ) => (
    <View>
      <Text nativeID={`${key}-label`} style={labelStyle}>
        {label}
      </Text>
      <TextInput
        accessibilityLabel={label}
        accessibilityLabelledBy={`${key}-label`}
        value={form[key]}
        onChangeText={(text) => setForm((prev) => ({ ...prev, [key]: text }))}
        multiline={options.multiline}
        style={{
          ...inputStyle(Boolean(errorFor(key)), options.multiline),
          ...(options.multiline ? { textAlignVertical: 'top' as const } : {}),
        }}
      />
      {errorFor(key) ? (
        <Text accessibilityLiveRegion="polite" style={errorStyle}>
          {errorFor(key)}
        </Text>
      ) : null}
    </View>
  );

  return (
    <Screen>
      <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>
        For when the CAD feed is down or missing: key the dispatch in by hand.
      </Text>

      <Card title="Call">
        <View style={{ gap: spacing.md }}>
          {field('Incident type', 'incidentType')}
          {field('Address', 'address')}
          {field('Cross streets', 'crossStreets')}

          <View
            testID="locality-group"
            accessibilityRole="radiogroup"
            accessibilityLabel={LOCALITY_LABEL}
            accessibilityLabelledBy="locality-label"
          >
            <Text nativeID="locality-label" style={labelStyle}>
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
                      minHeight: FIELD_TARGET,
                      justifyContent: 'center',
                      paddingHorizontal: spacing.md,
                      marginTop: spacing.sm,
                      // Selected: the amber selection mark (3:1 on the card) on a soft amber fill.
                      borderWidth: selected ? 2 : 1,
                      borderColor: selected ? theme.indicator : theme.border,
                      borderRadius: radiusScale.md,
                      backgroundColor: selected ? theme.accentSubtle : theme.surface,
                    }}
                  >
                    <Text
                      style={{
                        color: selected ? theme.onAccentSubtle : theme.fg,
                        fontSize: INPUT_TEXT,
                        fontWeight: selected ? '700' : '400',
                      }}
                    >
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
                      style={inputStyle(false)}
                    />
                  ) : null}
                </View>
              );
            })}
            {localityError ? (
              <Text accessibilityLiveRegion="polite" style={errorStyle}>
                {localityError}
              </Text>
            ) : null}
          </View>
        </View>
      </Card>

      <Card title="Details">
        <View style={{ gap: spacing.md }}>
          <View>
            <Text nativeID="units-label" style={labelStyle}>
              Units requested (comma separated, optional)
            </Text>
            <TextInput
              accessibilityLabel="Units requested"
              accessibilityLabelledBy="units-label"
              value={unitsText}
              onChangeText={setUnitsText}
              style={inputStyle(false)}
            />
          </View>

          {field('Narrative', 'narrative', { multiline: true })}
          {field('Operator-entered reference', 'externalDispatchId')}

          {formError ? (
            <Notice tone="warning">
              <Text accessibilityRole="alert" style={noticeText(theme, 'warning', true)}>
                {formError}
              </Text>
            </Notice>
          ) : null}

          <Button
            label={submitting ? 'Submitting…' : 'Submit dispatch'}
            disabled={submitting}
            fullWidth
            onPress={() => void submit()}
          />
        </View>
      </Card>
    </Screen>
  );
}
