import { spacing, typeScale, type StatusRole } from '@boxalarm/design-tokens';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Alert, Text, View } from 'react-native';
import { Button, Card, Screen, StatusChip, useTheme } from '../../components/ui';
import { retryPendingUnregister, useAuth, type SignOutResult } from '../../auth/AuthContext';
import { useAlertReadiness } from '../../features/alerts/useAlertReadiness';
import { useMeRepository } from '../../features/me/apiMeRepository';
import { MarkOffList } from '../../features/schedule/MarkOffList';
import type { LosapTotal, MemberProfile, Qualification } from '../../features/me/types';
import * as syncManager from '../../sync/syncManager';
import { InfoRow, NavRow, Rows } from './MeRows';

/**
 * The header's status: whether this phone can wake the member for a page - the same device checks
 * that raise the red readiness banner, so the two never disagree. "Checking" until they have run.
 */
function readinessChip(
  items: readonly unknown[] | null,
  blocking: readonly unknown[],
): { status: StatusRole; label: string } {
  if (items === null) return { status: 'neutral', label: 'Checking this phone' };
  return blocking.length > 0
    ? { status: 'danger', label: 'Phone may not wake you' }
    : { status: 'ok', label: 'Phone ready for pages' };
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

export const PUSH_NOT_REVOKED_TITLE = 'This phone may still get pages for you';
export const PUSH_NOT_REVOKED_MESSAGE =
  "You're signed out, but Boxalarm couldn't confirm this phone was taken off paging for you. It keeps trying whenever there's signal. Try again with signal, or ask an officer to remove this phone.";

/**
 * A sign-out whose push revoke did not land is never silent (M3): the phone may keep ringing for
 * the member who just left it. Retry runs the pending revoke at once; if it still cannot land,
 * the member is told again.
 */
export function reportSignOut(result: SignOutResult | void): void {
  if (!result || result.pushRevoked) return;
  Alert.alert(PUSH_NOT_REVOKED_TITLE, PUSH_NOT_REVOKED_MESSAGE, [
    { text: 'OK', style: 'cancel' },
    {
      text: 'Retry',
      onPress: () => {
        void retryPendingUnregister().then((outcome) => {
          if (outcome === 'failed') reportSignOut({ pushRevoked: false });
        });
      },
    },
  ]);
}

function reportSignOutError(error: unknown): void {
  console.error('[auth] sign-out did not finish cleanly', error);
}

export async function confirmSignOut(
  signOut: () => Promise<SignOutResult | void>,
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
                void syncManager
                  .discardAllFor(memberId)
                  .then(() => signOut())
                  .then(reportSignOut, reportSignOutError);
              },
            },
          ]
        : []),
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: () => void signOut().then(reportSignOut, reportSignOutError),
      },
    ],
    { cancelable: true },
  );
}

export function MeHomeScreen() {
  const { signOut, memberId } = useAuth();
  const navigation = useNavigation();
  const theme = useTheme();
  const repository = useMeRepository();
  const readiness = useAlertReadiness();
  const [profile, setProfile] = useState<MemberProfile | null>(null);
  const [quals, setQuals] = useState<Qualification[]>([]);
  const [losap, setLosap] = useState<LosapTotal | null>(null);
  // Sign-out can take a while on a weak link (a last send, the push revoke with a renewal): say
  // so and take the button away, so nobody taps it again wondering whether it worked (N-m5).
  const [signingOut, setSigningOut] = useState(false);
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );
  const signOutWithProgress = async () => {
    setSigningOut(true);
    AccessibilityInfo.announceForAccessibility('Signing out.');
    try {
      return await signOut();
    } finally {
      if (mountedRef.current) setSigningOut(false);
    }
  };

  // ProfileEditScreen saves and navigates straight back here (goBack), so the profile the member
  // just edited has to come back on screen focus, not only on first mount - otherwise Me shows
  // the stale name/phone until the app is force-closed and reopened (#144).
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      repository.getProfile().then((result) => {
        if (!cancelled) setProfile(result);
      });
      return () => {
        cancelled = true;
      };
    }, [repository]),
  );

  useEffect(() => {
    let cancelled = false;
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

  const go = (screen: string) => () => navigation.navigate(screen as never);
  const chip = readinessChip(readiness.items, readiness.blocking);
  const initials = profile ? `${profile.firstName.charAt(0)}${profile.lastName.charAt(0)}` : '';

  return (
    <Screen>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{
              width: 56,
              height: 56,
              borderRadius: 28,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: theme.accentSubtle,
            }}
          >
            <Text
              style={{
                color: theme.onAccentSubtle,
                fontSize: typeScale.title.size,
                fontWeight: '700',
              }}
            >
              {initials}
            </Text>
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text
              accessibilityRole="header"
              style={{ color: theme.fg, fontSize: typeScale.title.size, fontWeight: '700' }}
            >
              {profile ? `${profile.firstName} ${profile.lastName}` : ''}
            </Text>
            {profile && (
              <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>
                {profile.rank}
              </Text>
            )}
          </View>
        </View>
        <StatusChip status={chip.status} label={chip.label} />
        {/* F2.5 / design.md F-06: marking off is the member's core self-service task, so it is the
            first action on Me - it was unreachable from anywhere in the app. */}
        <View style={{ marginTop: spacing.sm }}>
          <Button
            label="Mark unavailable"
            size="alert"
            fullWidth
            accessibilityLabel="Mark unavailable. Choose how long you won't be alerted."
            onPress={go('Availability')}
          />
        </View>
        <MarkOffList />
      </Card>

      {/* Second on Me, not last: the self-test is how a member proves this phone will wake them. */}
      <Card title="Notifications & phone readiness">
        <Rows>
          <NavRow
            title="Test my alert path"
            detail="Send a test page and check this phone rings"
            onPress={go('SelfTest')}
          />
          <NavRow
            title="Why didn't I get the page?"
            detail="Delivery timeline for your recent pages"
            onPress={go('Diagnostics')}
          />
          <NavRow
            title="Notifications"
            detail="Reminders about certifications, PPE and apparatus"
            onPress={go('Inbox')}
          />
          <NavRow
            title="Notification preferences"
            detail="Mute reminders. Dispatch alerts can't be muted."
            onPress={go('NotificationPreferences')}
          />
        </Rows>
      </Card>

      <Card title="Profile & qualifications">
        <Rows>
          <NavRow
            title="Edit profile"
            detail={profile ? (profile.phone ?? 'No phone number on file') : undefined}
            onPress={go('ProfileEdit')}
          />
          <View style={{ paddingVertical: spacing.sm }}>
            <Text
              accessibilityRole="header"
              style={{ color: theme.fgMuted, fontSize: typeScale.label.size, fontWeight: '600' }}
            >
              My qualifications
            </Text>
            {quals.map((qual) => (
              <InfoRow
                key={qual.qualCode}
                title={qual.qualCode}
                accessibilityLabel={`${qual.qualCode} — ${
                  qual.currentlyEligible ? 'Eligible' : 'Not currently eligible'
                }`}
                trailing={
                  <StatusChip
                    status={qual.currentlyEligible ? 'ok' : 'warning'}
                    label={qual.currentlyEligible ? 'Eligible' : 'Not currently eligible'}
                  />
                }
              />
            ))}
          </View>
          <NavRow
            title="Certifications"
            detail="What you hold and when it expires"
            onPress={go('Certifications')}
          />
        </Rows>
      </Card>

      <Card title="Training & LOSAP">
        <Rows>
          <NavRow
            title={losap ? 'Attendance & LOSAP' : 'Attendance'}
            detail={losap ? `${losap.totalPoints} pts this year` : undefined}
            accessibilityLabel={
              losap ? `Attendance & LOSAP (${losap.totalPoints} pts this year)` : 'Attendance'
            }
            onPress={go('Attendance')}
          />
          <NavRow
            title="Transcript"
            detail="Certifications and training hours"
            onPress={go('Transcript')}
          />
        </Rows>
      </Card>

      <Card title="My gear">
        <Rows>
          <NavRow title="My equipment" onPress={go('MyEquipment')} />
          <NavRow title="My PPE" onPress={go('MyPpe')} />
        </Rows>
      </Card>

      <Card>
        <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>
          Signing out stops Boxalarm pages on this phone.
        </Text>
        <Button
          label={signingOut ? 'Signing out…' : 'Sign out'}
          variant="danger"
          fullWidth
          accessibilityLabel={
            signingOut ? 'Signing out.' : 'Sign out. Boxalarm pages stop on this phone.'
          }
          disabled={signingOut}
          onPress={() => void confirmSignOut(signOutWithProgress, profile?.phone, memberId)}
        />
      </Card>
    </Screen>
  );
}
