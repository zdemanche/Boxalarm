import { spacing, targetSize, typeScale } from '@boxalarm/design-tokens';
import { useNavigation } from '@react-navigation/native';
import { useEffect, useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { Button, Screen, useTheme, type SurfaceTheme } from '../../components/ui';
import { useAuth } from '../../auth/AuthContext';
import { useMeRepository } from '../../features/me/apiMeRepository';
import type { LosapTotal, MemberProfile, Qualification } from '../../features/me/types';

function NavRow({
  label,
  onPress,
  theme,
}: {
  label: string;
  onPress: () => void;
  theme: SurfaceTheme;
}) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      onPress={onPress}
      style={{
        minHeight: targetSize.field,
        justifyContent: 'center',
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.md,
        borderBottomWidth: 1,
        borderBottomColor: theme.borderDecorative,
      }}
    >
      <Text style={{ color: theme.fg, fontSize: typeScale.body.size }}>{label}</Text>
    </TouchableOpacity>
  );
}

export function MeHomeScreen() {
  const { signOut } = useAuth();
  const navigation = useNavigation();
  const theme = useTheme();
  const repository = useMeRepository();
  const [profile, setProfile] = useState<MemberProfile | null>(null);
  const [quals, setQuals] = useState<Qualification[]>([]);
  const [losap, setLosap] = useState<LosapTotal | null>(null);

  useEffect(() => {
    let cancelled = false;
    repository.getProfile().then((result) => {
      if (!cancelled) setProfile(result);
    });
    repository.getQualifications().then((result) => {
      if (!cancelled) setQuals(result);
    });
    repository.getLosapTotal().then((result) => {
      if (!cancelled) setLosap(result);
    });
    return () => {
      cancelled = true;
    };
  }, [repository]);

  return (
    <Screen>
      <View style={{ alignItems: 'center', marginBottom: spacing.md }}>
        <Text
          accessibilityRole="header"
          style={{ color: theme.fg, fontSize: typeScale.title.size, fontWeight: '700' }}
        >
          {profile ? `${profile.firstName} ${profile.lastName}` : ''}
        </Text>
        {profile && (
          <Text
            style={{
              color: theme.fgMuted,
              fontSize: typeScale.body.size,
              marginTop: spacing.xs,
            }}
          >
            {profile.rank}
          </Text>
        )}
      </View>
      <NavRow
        label="Edit profile"
        theme={theme}
        onPress={() => navigation.navigate('ProfileEdit' as never)}
      />
      <View
        style={{
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.md,
          borderBottomWidth: 1,
          borderBottomColor: theme.borderDecorative,
        }}
      >
        <Text
          accessibilityRole="header"
          style={{ color: theme.fg, fontSize: typeScale.body.size, fontWeight: '600' }}
        >
          My qualifications
        </Text>
        {quals.map((qual) => (
          <Text key={qual.qualCode} style={{ color: theme.fg, marginTop: spacing.xs }}>
            {qual.qualCode} — {qual.currentlyEligible ? 'Eligible' : 'Not currently eligible'}
          </Text>
        ))}
      </View>
      <NavRow
        label={losap ? `Attendance & LOSAP (${losap.totalPoints} pts this year)` : 'Attendance'}
        theme={theme}
        onPress={() => navigation.navigate('Attendance' as never)}
      />
      <NavRow
        label="Certifications"
        theme={theme}
        onPress={() => navigation.navigate('Certifications' as never)}
      />
      <NavRow
        label="My equipment"
        theme={theme}
        onPress={() => navigation.navigate('MyEquipment' as never)}
      />
      <NavRow
        label="My PPE"
        theme={theme}
        onPress={() => navigation.navigate('MyPpe' as never)}
      />
      <NavRow
        label="Transcript"
        theme={theme}
        onPress={() => navigation.navigate('Transcript' as never)}
      />
      <NavRow
        label="Notifications"
        theme={theme}
        onPress={() => navigation.navigate('Inbox' as never)}
      />
      <NavRow
        label="Notification preferences"
        theme={theme}
        onPress={() => navigation.navigate('NotificationPreferences' as never)}
      />
      <NavRow
        label="Test my alert path"
        theme={theme}
        onPress={() => navigation.navigate('SelfTest' as never)}
      />
      <NavRow
        label="Why didn't I get the page?"
        theme={theme}
        onPress={() => navigation.navigate('Diagnostics' as never)}
      />
      <View style={{ paddingTop: spacing.lg }}>
        <Button label="Sign out" variant="danger" onPress={() => void signOut()} />
      </View>
    </Screen>
  );
}
