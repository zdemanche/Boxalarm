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
import { useMeRepository } from '../../features/me/apiMeRepository';
import type { LosapTotal, MemberProfile, Qualification } from '../../features/me/types';

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
          label="Edit profile"
          tokens={tokens}
          onPress={() => navigation.navigate('ProfileEdit' as never)}
        />
        <View
          style={{
            paddingHorizontal: spacing.lg,
            paddingVertical: spacing.md,
            borderBottomWidth: 1,
            borderBottomColor: tokens.foreground + '22',
          }}
        >
          <Text
            accessibilityRole="header"
            style={{ color: tokens.foreground, fontSize: typography.size.base, fontWeight: '600' }}
          >
            My qualifications
          </Text>
          {quals.map((qual) => (
            <Text key={qual.qualCode} style={{ color: tokens.foreground, marginTop: spacing.xs }}>
              {qual.qualCode} — {qual.currentlyEligible ? 'Eligible' : 'Not currently eligible'}
            </Text>
          ))}
        </View>
        <NavRow
          label={losap ? `Attendance & LOSAP (${losap.totalPoints} pts this year)` : 'Attendance'}
          tokens={tokens}
          onPress={() => navigation.navigate('Attendance' as never)}
        />
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
