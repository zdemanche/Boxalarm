import { radiusScale, spacing, targetSize, typeScale } from '@boxalarm/design-tokens';
import { useNavigation } from '@react-navigation/native';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Alert, Text, TextInput, View } from 'react-native';
import { Button, Card, Screen, useTheme } from '../../components/ui';
import { useMeRepository } from '../../features/me/apiMeRepository';
import { ApiError } from '../../lib/apiClient';
import { ROW_TITLE_SIZE } from './MeRows';

function FieldLabel({ children, nativeID }: { children: string; nativeID?: string }) {
  const theme = useTheme();
  return (
    <Text
      nativeID={nativeID}
      style={{ color: theme.fgMuted, fontSize: typeScale.label.size, fontWeight: '600' }}
    >
      {children}
    </Text>
  );
}

function Field({
  label,
  value,
  onChangeText,
}: {
  label: string;
  value: string;
  onChangeText: (next: string) => void;
}) {
  const theme = useTheme();
  return (
    <View style={{ gap: spacing.xs }}>
      <FieldLabel nativeID={`${label}-label`}>{label}</FieldLabel>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        style={{
          minHeight: targetSize.field,
          borderWidth: 1,
          borderColor: theme.border,
          borderRadius: radiusScale.lg,
          backgroundColor: theme.card,
          paddingHorizontal: spacing.md,
          color: theme.fg,
          fontSize: ROW_TITLE_SIZE,
        }}
      />
    </View>
  );
}

export function ProfileEditScreen() {
  const navigation = useNavigation();
  const theme = useTheme();
  const repository = useMeRepository();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [loadedPhone, setLoadedPhone] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [status, setStatus] = useState<
    'loading' | 'loadError' | 'idle' | 'saving' | 'saved' | 'error'
  >('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    repository
      .getProfile()
      .then((profile) => {
        if (cancelled) return;
        setFirstName(profile.firstName);
        setLastName(profile.lastName);
        setEmail(profile.email);
        setPhone(profile.phone ?? '');
        setLoadedPhone(profile.phone ?? '');
        setStatus('idle');
      })
      .catch(() => {
        if (!cancelled) setStatus('loadError');
      });
    return () => {
      cancelled = true;
    };
  }, [repository, loadAttempt]);

  const handleSave = async () => {
    const trimmedPhone = phone.trim();
    const phoneUpdate =
      trimmedPhone === loadedPhone ? {} : { phone: trimmedPhone === '' ? null : trimmedPhone };
    setStatus('saving');
    setError(null);
    try {
      // No email: the server refuses a member changing their own (403) - only a chief or admin
      // can, because it is also their sign-in, kept in step with Cognito.
      await repository.updateProfile({ firstName, lastName, ...phoneUpdate });
      setStatus('saved');
      AccessibilityInfo.announceForAccessibility('Profile saved');
      navigation.goBack();
    } catch (e) {
      setStatus('error');
      const message =
        e instanceof ApiError && e.problem.status === 403
          ? 'You do not have access to update this profile.'
          : e instanceof ApiError && e.problem.status === 400 && e.problem.detail
            ? e.problem.detail
            : 'Could not save. Try again.';
      setError(message);
      AccessibilityInfo.announceForAccessibility(message);
    }
  };

  const confirmSave = () => {
    if (loadedPhone !== '' && phone.trim() === '') {
      Alert.alert(
        'Remove your phone number?',
        'You will stop getting text and voice pages. Boxalarm pages on this phone are not affected.',
        [
          { text: 'Keep number', style: 'cancel' },
          { text: 'Remove and save', style: 'destructive', onPress: () => void handleSave() },
        ],
      );
      return;
    }
    void handleSave();
  };

  if (status === 'loading') {
    return (
      <Screen scroll={false}>
        <ActivityIndicator accessibilityLabel="Loading your profile" />
      </Screen>
    );
  }

  if (status === 'loadError') {
    return (
      <Screen scroll={false}>
        <Card>
          <View style={{ gap: spacing.md }}>
            <Text
              accessibilityRole="alert"
              style={{ color: theme.status.danger, fontSize: typeScale.body.size }}
            >
              Could not load your profile. Try again when you have signal.
            </Text>
            <Button label="Try again" fullWidth onPress={() => setLoadAttempt((n) => n + 1)} />
          </View>
        </Card>
      </Screen>
    );
  }

  // Not scrolling, as before: a scroll view would spend the first tap on Save dismissing the
  // keyboard.
  return (
    <Screen scroll={false}>
      <Card>
        <View style={{ gap: spacing.md }}>
          <Field label="First name" value={firstName} onChangeText={setFirstName} />
          <Field label="Last name" value={lastName} onChangeText={setLastName} />
          <View style={{ gap: spacing.xs }}>
            <FieldLabel>Email</FieldLabel>
            <Text
              accessibilityLabel={`Email, ${email}. To change your email, ask a chief or admin.`}
              style={{ color: theme.fg, fontSize: ROW_TITLE_SIZE }}
            >
              {email}
            </Text>
            <Text
              importantForAccessibility="no"
              style={{ color: theme.fgMuted, fontSize: typeScale.bodyDense.size }}
            >
              To change your email, ask a chief or admin.
            </Text>
          </View>
          <Field label="Phone" value={phone} onChangeText={setPhone} />
          {error ? (
            <Text
              accessibilityRole="alert"
              style={{ color: theme.status.danger, fontSize: typeScale.body.size }}
            >
              {error}
            </Text>
          ) : null}
          <Button label="Save" fullWidth loading={status === 'saving'} onPress={confirmSave} />
        </View>
      </Card>
    </Screen>
  );
}
