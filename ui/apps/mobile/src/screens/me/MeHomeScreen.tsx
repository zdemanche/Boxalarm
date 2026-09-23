import {
  palette,
  radius,
  spacing,
  touchTarget,
  typography,
  type PaletteColors,
} from '@boxalarm/design-tokens';
import { useNavigation } from '@react-navigation/native';
import { useEffect, useState } from 'react';
import { ScrollView, Text, TouchableOpacity, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../../auth/AuthContext';
import { mockMeRepository } from '../../features/me/mockMeRepository';
import type { MemberProfile } from '../../features/me/types';

function NavRow({
  label,
  onPress,
  tokens,
}: {
  label: string;
  onPress: () => void;
  tokens: PaletteColors;
}) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      onPress={onPress}
      style={{
        minHeight: touchTarget.baseline.ios,
        justifyContent: 'center',
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.md,
        borderBottomWidth: 1,
        borderBottomColor: tokens.foreground + '22',
      }}
    >
      <Text style={{ color: tokens.foreground, fontSize: typography.size.base }}>{label}</Text>
    </TouchableOpacity>
  );
}

export function MeHomeScreen() {
  const { signOut } = useAuth();
  const navigation = useNavigation();
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;
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
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
      <ScrollView>
        <View style={{ padding: spacing.lg, alignItems: 'center' }}>
          <Text
            accessibilityRole="header"
            style={{ color: tokens.foreground, fontSize: typography.size.xl, fontWeight: '700' }}
          >
            {profile ? `${profile.firstName} ${profile.lastName}` : ''}
          </Text>
          {profile && (
            <Text
              style={{
                color: tokens.foreground,
                opacity: 0.7,
                fontSize: typography.size.base,
                marginTop: spacing.xs,
              }}
            >
              {profile.rank}
            </Text>
          )}
        </View>
        <NavRow
          label="Certifications"
          tokens={tokens}
          onPress={() => navigation.navigate('Certifications' as never)}
        />
        <NavRow
          label="Test my alert path"
          tokens={tokens}
          onPress={() => navigation.navigate('SelfTest' as never)}
        />
        <NavRow
          label="Why didn't I get the page?"
          tokens={tokens}
          onPress={() => navigation.navigate('Diagnostics' as never)}
        />
        <View style={{ padding: spacing.lg }}>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Sign out"
            onPress={() => void signOut()}
            style={{
              minHeight: touchTarget.baseline.ios,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: radius.default,
              borderWidth: 1,
              borderColor: tokens.error,
            }}
          >
            <Text
              style={{ color: tokens.error, fontSize: typography.size.base, fontWeight: '600' }}
            >
              Sign out
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
