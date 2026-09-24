import { palette, radius, spacing, touchTarget, typography } from '@boxalarm/design-tokens';
import { useNavigation } from '@react-navigation/native';
import { useEffect, useState } from 'react';
import {
  AccessibilityInfo,
  Text,
  TextInput,
  TouchableOpacity,
  useColorScheme,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useMeRepository } from '../../features/me/apiMeRepository';
import { ApiError } from '../../lib/apiClient';

function inputStyle(tokens: { foreground: string }) {
  return {
    minHeight: touchTarget.baseline.ios,
    borderWidth: 1,
    borderColor: tokens.foreground + '33',
    borderRadius: radius.default,
    paddingHorizontal: spacing.md,
    color: tokens.foreground,
    fontSize: typography.size.base,
  };
}

function Field({
  label,
  value,
  onChangeText,
  tokens,
}: {
  label: string;
  value: string;
  onChangeText: (next: string) => void;
  tokens: { foreground: string };
}) {
  return (
    <View style={{ marginTop: spacing.lg }}>
      <Text
        nativeID={`${label}-label`}
        style={{ color: tokens.foreground, fontSize: typography.size.sm, marginBottom: spacing.xs }}
      >
        {label}
      </Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        style={inputStyle(tokens)}
      />
    </View>
  );
}

export function ProfileEditScreen() {
  const navigation = useNavigation();
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;
  const repository = useMeRepository();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [status, setStatus] = useState<'loading' | 'idle' | 'saving' | 'saved' | 'error'>(
    'loading',
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    repository.getProfile().then((profile) => {
      if (cancelled) return;
      setFirstName(profile.firstName);
      setLastName(profile.lastName);
      setEmail(profile.email);
      setPhone(profile.phone);
      setStatus('idle');
    });
    return () => {
      cancelled = true;
    };
  }, [repository]);

  const handleSave = async () => {
    setStatus('saving');
    setError(null);
    try {
      await repository.updateProfile({ firstName, lastName, email, phone });
      setStatus('saved');
      AccessibilityInfo.announceForAccessibility('Profile saved');
      navigation.goBack();
    } catch (e) {
      setStatus('error');
      setError(
        e instanceof ApiError && e.problem.status === 403
          ? 'You do not have access to update this profile.'
          : 'Could not save. Try again.',
      );
      AccessibilityInfo.announceForAccessibility(error ?? 'Could not save');
    }
  };

  if (status === 'loading') {
    return <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }} />;
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background, padding: spacing.lg }}>
      <Field label="First name" value={firstName} onChangeText={setFirstName} tokens={tokens} />
      <Field label="Last name" value={lastName} onChangeText={setLastName} tokens={tokens} />
      <Field label="Email" value={email} onChangeText={setEmail} tokens={tokens} />
      <Field label="Phone" value={phone} onChangeText={setPhone} tokens={tokens} />
      {error ? (
        <Text accessibilityRole="alert" style={{ color: tokens.error, marginTop: spacing.md }}>
          {error}
        </Text>
      ) : null}
      <TouchableOpacity
        accessibilityRole="button"
        onPress={() => void handleSave()}
        disabled={status === 'saving'}
        style={{
          minHeight: touchTarget.baseline.ios,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: tokens.accent,
          borderRadius: radius.default,
          marginTop: spacing.xl,
          opacity: status === 'saving' ? 0.6 : 1,
        }}
      >
        <Text
          style={{ color: tokens.background, fontSize: typography.size.base, fontWeight: '600' }}
        >
          Save
        </Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}
