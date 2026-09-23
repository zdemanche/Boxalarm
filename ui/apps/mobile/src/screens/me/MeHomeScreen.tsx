import { spacing, targetSize, typeScale } from '@boxalarm/design-tokens';
import { useNavigation } from '@react-navigation/native';
import { useEffect, useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { Button, Screen, useTheme, type SurfaceTheme } from '../../components/ui';
import { useAuth } from '../../auth/AuthContext';
import { mockMeRepository } from '../../features/me/mockMeRepository';
import type { MemberProfile } from '../../features/me/types';

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
  const [profile, setProfile] = useState<MemberProfile | null>(null);

  useEffect(() => {
    let cancelled = false;
    mockMeRepository.getProfile().then((result) => {
      if (!cancelled) setProfile(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
        label="Certifications"
        theme={theme}
        onPress={() => navigation.navigate('Certifications' as never)}
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
