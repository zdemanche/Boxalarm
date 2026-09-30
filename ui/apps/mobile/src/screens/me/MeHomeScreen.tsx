import { spacing, targetSize, typeScale } from '@boxalarm/design-tokens';
import { useNavigation } from '@react-navigation/native';
import { useEffect, useState } from 'react';
import { Alert, Text, TouchableOpacity, View } from 'react-native';
import { Button, Screen, useTheme, type SurfaceTheme } from '../../components/ui';
import { useAuth } from '../../auth/AuthContext';
import { useMeRepository } from '../../features/me/apiMeRepository';
import type { LosapTotal, MemberProfile, Qualification } from '../../features/me/types';
import * as syncManager from '../../sync/syncManager';

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

/**
 * Sign-out is not a routine tap on this app: it removes THIS installation's push registration
 * (personnel-service pushTokens, one registration per device since fix/page-chain), so this phone
 * stops being paged while the member's other signed-in devices keep getting pages (alert-ux C7,
 * review MJ-5 / round 2 C-9). Text or voice pages are mentioned only as conditional. Staying signed
 * in is the default.
 */
export function signOutWarning(phone: string | null | undefined): string {
  const appPages =
    'Boxalarm pages stop on this phone until you sign in again; your other signed-in devices keep getting pages.';
  const other = phone
    ? ` Text and voice pages to ${phone} continue only if they are set up for you - check with your officer if you are not sure.`
    : ' No phone number is on file, so you would get no text or voice pages either.';
  return appPages + other;
}

export async function confirmSignOut(
  signOut: () => Promise<void>,
  phone?: string | null,
  memberId?: string | null,
): Promise<void> {
  // Work this member queued stays theirs: it is held on the phone and sent only when they sign
  // in again, never under the next member (R2-M3). Say so, and let them discard it instead.
  const unsent = memberId ? await syncManager.countUnsentFor(memberId).catch(() => 0) : 0;
  const unsentNote =
    unsent > 0
      ? `\n\n${unsent} ${unsent === 1 ? "item hasn't" : "items haven't"} been sent yet. ${
          unsent === 1 ? 'It' : 'They'
        }'ll send next time you sign in on this phone.`
      : '';
  Alert.alert(
    'Sign out and stop getting pages on this phone?',
    signOutWarning(phone) + unsentNote,
    [
      { text: 'Stay signed in', style: 'cancel' },
      ...(unsent > 0 && memberId
        ? [
            {
              text: `Discard ${unsent} unsent and sign out`,
              style: 'destructive' as const,
              onPress: () => {
                void syncManager.discardAllFor(memberId).then(() => signOut());
              },
            },
          ]
        : []),
      { text: 'Sign out', style: 'destructive', onPress: () => void signOut() },
    ],
    { cancelable: true },
  );
}

export function MeHomeScreen() {
  const { signOut, memberId } = useAuth();
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
      {/* F2.5 / design.md F-06: marking off is the member's core self-service task, so it is the
          first action on Me - it was unreachable from anywhere in the app. */}
      <View style={{ marginBottom: spacing.md }}>
        <Button
          label="Mark unavailable"
          size="alert"
          fullWidth
          accessibilityLabel="Mark unavailable. Choose how long you won't be alerted."
          onPress={() => navigation.navigate('Availability' as never)}
        />
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
      <NavRow label="My PPE" theme={theme} onPress={() => navigation.navigate('MyPpe' as never)} />
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
        <Button
          label="Sign out"
          variant="danger"
          accessibilityLabel="Sign out. Boxalarm pages stop on this phone."
          onPress={() => void confirmSignOut(signOut, profile?.phone, memberId)}
        />
      </View>
    </Screen>
  );
}
