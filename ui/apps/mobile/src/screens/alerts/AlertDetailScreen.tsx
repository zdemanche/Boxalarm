import { radius, spacing, statusChipPalette, typeScale } from '@boxalarm/design-tokens';
import { useNavigation, useRoute, type NavigationProp } from '@react-navigation/native';
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import {
  AccessibilityInfo,
  findNodeHandle,
  Linking,
  Platform,
  ScrollView,
  Text,
  TouchableOpacity,
  useColorScheme,
  View,
  type AccessibilityActionEvent,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useOptionalAuth } from '../../auth/AuthContext';
import { useTheme } from '../../components/ui';
import { useAlertsRepository } from '../../features/alerts/apiAlertsRepository';
import type { AlertPayload } from '../../features/alerts/alertPayload';
import { setAlertShowsOverLockScreen } from '../../features/alerts/alertReadiness';
import { ETA_CHOICES_MINUTES, type ResponseAnswer } from '../../features/alerts/alertResponses';
import { formatClock, formatElapsed } from '../../features/alerts/elapsed';
import { matchNotice, PrePlanPanel } from '../../features/alerts/PrePlanPanel';
import { silenceDispatchNotification } from '../../features/alerts/pushNotificationDisplay';
import { ResponseStatus, responseDeliveryCopy } from '../../features/alerts/ResponseStatus';
import { useAlertDetail, type DetailFailure } from '../../features/alerts/useAlertDetail';
import { useAlertResponse, type ResponseDelivery } from '../../features/alerts/useAlertResponse';
import type { AlertsStackParamList } from '../../navigation/AlertsStack';
import { useOptionalConnectivity } from '../../sync/ConnectivityContext';

// a11y-spec §1.11 alert-path targets: the primary answer is full width x 88, the others 72, with
// 16 between; every other control on this screen is at least 72.
const PRIMARY_TARGET = 88;
const ALERT_TARGET = 72;

// a11y-spec N1: full-sentence accessible names.
const ANSWER_NAME: Record<ResponseAnswer, string> = {
  RESPONDING: "Responding — you're going to the station",
  DIRECT_TO_SCENE: 'Responding direct to scene',
  NOT_RESPONDING: 'Not responding',
};

// a11y-spec N1 Error: the reassurance is required - a visible failure next to an address makes a
// member doubt the address.
function failureText(failure: DetailFailure, hasAddress: boolean): string {
  const reassurance = hasAddress
    ? ' The address above came with the page and is correct.'
    : ' Your response buttons still work.';
  switch (failure) {
    case 'refused':
      return `The server refused to show this call's details.${reassurance}`;
    case 'server':
      return `The server couldn't load this call's details right now.${reassurance}`;
    case 'timeout':
    case 'unreachable':
      return `We couldn't load the call details - no answer from the server.${reassurance}`;
  }
}

function answerAccessibilityName(
  answer: ResponseAnswer,
  selected: boolean,
  delivery: ResponseDelivery | null,
): string {
  if (!selected || !delivery) return ANSWER_NAME[answer];
  return `${ANSWER_NAME[answer]}. Your answer, ${responseDeliveryCopy(delivery).spoken}`;
}

interface AnswerButtonProps {
  answer: ResponseAnswer;
  label: string;
  sublabel?: string;
  height: number;
  fill: string | null;
  onFill: string;
  outline: string;
  selected: boolean;
  delivery: ResponseDelivery | null;
  onPress: () => void;
}

function AnswerButton({
  answer,
  label,
  sublabel,
  height,
  fill,
  onFill,
  outline,
  selected,
  delivery,
  onPress,
}: AnswerButtonProps) {
  const theme = useTheme();
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={answerAccessibilityName(answer, selected, delivery)}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={{
        minHeight: height,
        width: '100%',
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.md,
        borderRadius: radius.default,
        backgroundColor: fill ?? 'transparent',
        // Selected is carried by a heavy focus-colour ring and a word, not colour alone.
        borderWidth: selected ? 5 : fill ? 0 : 2,
        borderColor: selected ? theme.focus : outline,
      }}
    >
      <Text style={{ color: onFill, fontSize: typeScale.title.size, fontWeight: '800' }}>
        {selected ? '✓ ' : ''}
        {label}
      </Text>
      {selected ? (
        <Text style={{ color: onFill, fontSize: typeScale.label.size, fontWeight: '700' }}>
          YOUR ANSWER
        </Text>
      ) : sublabel ? (
        <Text style={{ color: onFill, fontSize: typeScale.label.size, fontWeight: '600' }}>
          {sublabel}
        </Text>
      ) : null}
    </TouchableOpacity>
  );
}

function announce(message: string, assertive: boolean): void {
  if (assertive && Platform.OS === 'ios') {
    AccessibilityInfo.announceForAccessibilityWithOptions(message, { queue: false });
    return;
  }
  AccessibilityInfo.announceForAccessibility(message);
}

export function AlertDetailScreen() {
  const navigation = useNavigation<NavigationProp<AlertsStackParamList>>();
  const route = useRoute();
  const { dispatchId, payload } = route.params as { dispatchId: string; payload?: AlertPayload };
  const theme = useTheme();
  const scheme = useColorScheme();
  const chips = statusChipPalette[scheme === 'dark' ? 'cab' : 'day'];
  const repository = useAlertsRepository();
  const {
    header,
    detail: dispatch,
    detailCachedAt,
    status,
    failure,
    retry,
  } = useAlertDetail(repository, dispatchId, payload);
  const auth = useOptionalAuth();
  const { isOnline } = useOptionalConnectivity();
  const response = useAlertResponse(repository, dispatchId, auth?.memberId ?? null, isOnline);
  const [narrativeExpanded, setNarrativeExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const headerRef = useRef<ComponentRef<typeof Text>>(null);
  const announcedRef = useRef<string | null>(null);

  // The call is open: stop the looping alarm. Leaving the alert (another tab, back, a pushed
  // screen) ends its show-over-lock-screen, so the rest of the app is not open on a locked phone.
  useEffect(() => {
    void silenceDispatchNotification(dispatchId);
    const unsubscribeBlur = navigation.addListener?.('blur', () =>
      setAlertShowsOverLockScreen(false),
    );
    return () => {
      unsubscribeBlur?.();
      setAlertShowsOverLockScreen(false);
    };
  }, [dispatchId, navigation]);

  // Elapsed time is read on demand (never announced every tick) - refresh it twice a minute.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // a11y-spec §3.1 #2: on arrival, focus the header (address read before the buttons) and say
  // what and where, assertively - once per call, and not when re-opening an answered call.
  useEffect(() => {
    if (!header?.address || announcedRef.current === dispatchId || response.answer) return;
    announcedRef.current = dispatchId;
    const cross = header.crossStreets ? ` Cross streets ${header.crossStreets}.` : '';
    announce(
      `Incoming call. ${header.incidentType} at ${header.address}.${cross} Are you responding?`,
      true,
    );
    const tag = headerRef.current ? findNodeHandle(headerRef.current) : null;
    if (tag) AccessibilityInfo.setAccessibilityFocus(tag);
  }, [dispatchId, header, response.answer]);

  // Never blank (design.md F-01): the page payload paints the header, the answer buttons are
  // live at first paint, and the detail fetch only enriches. One tap saves the answer on the
  // phone (outbox, with a 10 min ETA the chips below change in one more tap) and the status
  // block says exactly whether it has reached the server.
  const respond = (answer: ResponseAnswer, etaMinutes?: number) => {
    void response.respond(answer, etaMinutes);
  };

  const onAccessibilityAction = (event: AccessibilityActionEvent) => {
    const byName: Record<string, ResponseAnswer> = {
      respond: 'RESPONDING',
      respondDirect: 'DIRECT_TO_SCENE',
      notResponding: 'NOT_RESPONDING',
    };
    const answer = byName[event.nativeEvent.actionName];
    if (answer) respond(answer);
  };

  const answer = response.answer;
  const selected = (value: ResponseAnswer) => answer?.ackStatus === value;
  const verify = dispatch?.prePlan ? matchNotice(dispatch.prePlan) : null;
  const dispatchedAt = header?.dispatchedAt ?? null;
  const tone = header?.toneSequence ?? null;
  const statusStrip = [
    tone ? `TONE ${tone}` : null,
    dispatchedAt ? formatClock(dispatchedAt) : null,
    dispatchedAt ? formatElapsed(dispatchedAt, now) : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}
        accessibilityLabel="Incoming call"
        accessibilityActions={[
          { name: 'respond', label: ANSWER_NAME.RESPONDING },
          { name: 'respondDirect', label: ANSWER_NAME.DIRECT_TO_SCENE },
          { name: 'notResponding', label: ANSWER_NAME.NOT_RESPONDING },
        ]}
        onAccessibilityAction={onAccessibilityAction}
      >
        {statusStrip || !isOnline ? (
          <View>
            {statusStrip ? (
              <Text
                accessibilityLiveRegion="none"
                style={{
                  color: theme.fgMuted,
                  fontSize: 15,
                  fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
                }}
              >
                {statusStrip}
              </Text>
            ) : null}
            {!isOnline ? (
              <Text style={{ color: theme.status.warning, fontSize: typeScale.body.size }}>
                You're offline. This call came through anyway - your answer will send when you have
                signal.
              </Text>
            ) : null}
          </View>
        ) : null}

        <View>
          <Text
            ref={headerRef}
            accessibilityRole="header"
            style={{
              color: theme.status.warning,
              fontSize: typeScale.display.size,
              lineHeight: typeScale.display.lineHeight,
              fontWeight: '700',
            }}
          >
            {(header?.incidentType ?? `Dispatch ${dispatchId}`).toUpperCase()}
          </Text>
          <Text
            selectable
            style={{ color: theme.fg, fontSize: 32, lineHeight: 40, fontWeight: '700' }}
          >
            {header?.address ||
              (status === 'failed' ? 'Address not available' : 'Loading the address…')}
          </Text>
          {header?.crossStreets ? (
            <Text style={{ color: theme.fg, fontSize: typeScale.heading.size, marginTop: 4 }}>
              x {header.crossStreets}
            </Text>
          ) : null}
        </View>

        {/* Directly under the address it qualifies (alert-ux M4), not below the buttons. */}
        {verify?.warning ? (
          <View
            accessibilityRole="alert"
            style={{
              padding: spacing.md,
              borderRadius: radius.default,
              borderWidth: 2,
              borderColor: chips.warning.onFill,
              backgroundColor: chips.warning.fill,
            }}
          >
            <Text
              style={{
                color: chips.warning.onFill,
                fontSize: typeScale.heading.size,
                fontWeight: '700',
              }}
            >
              ▲ {verify.text}
            </Text>
          </View>
        ) : null}

        {/* Answer stack: before the narrative, so a driving member reaches it first (N1 #3). */}
        <View style={{ gap: spacing.md }}>
          <AnswerButton
            answer="RESPONDING"
            label="RESPONDING"
            sublabel="to the station"
            height={PRIMARY_TARGET}
            fill={theme.status.ok}
            onFill={theme.bg}
            outline={theme.status.ok}
            selected={selected('RESPONDING')}
            delivery={response.delivery}
            onPress={() => respond('RESPONDING')}
          />
          <AnswerButton
            answer="DIRECT_TO_SCENE"
            label="DIRECT TO SCENE"
            height={ALERT_TARGET}
            fill={theme.status.warning}
            onFill={theme.bg}
            outline={theme.status.warning}
            selected={selected('DIRECT_TO_SCENE')}
            delivery={response.delivery}
            onPress={() => respond('DIRECT_TO_SCENE')}
          />
          <AnswerButton
            answer="NOT_RESPONDING"
            label="NOT RESPONDING"
            height={ALERT_TARGET}
            fill={null}
            onFill={theme.fg}
            outline={theme.status.danger}
            selected={selected('NOT_RESPONDING')}
            delivery={response.delivery}
            onPress={() => respond('NOT_RESPONDING')}
          />
        </View>

        {answer && answer.ackStatus !== 'NOT_RESPONDING' ? (
          <View accessibilityRole="radiogroup" accessibilityLabel="Your ETA" style={{ gap: 8 }}>
            <Text style={{ color: theme.fg, fontSize: typeScale.heading.size, fontWeight: '700' }}>
              ETA (minutes) - tap to change
            </Text>
            <View style={{ flexDirection: 'row', gap: spacing.sm }}>
              {ETA_CHOICES_MINUTES.map((minutes) => {
                const isSelected = answer.etaMinutes === minutes;
                return (
                  <TouchableOpacity
                    key={minutes}
                    accessibilityRole="radio"
                    accessibilityLabel={`ETA ${minutes} minutes`}
                    accessibilityState={{ selected: isSelected, checked: isSelected }}
                    onPress={() => respond(answer.ackStatus, minutes)}
                    style={{
                      flex: 1,
                      minHeight: ALERT_TARGET,
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: radius.default,
                      borderWidth: isSelected ? 5 : 2,
                      borderColor: isSelected ? theme.focus : theme.borderStrong,
                      backgroundColor: isSelected ? theme.surfaceRaised : 'transparent',
                    }}
                  >
                    <Text
                      style={{ color: theme.fg, fontSize: typeScale.title.size, fontWeight: '800' }}
                    >
                      {minutes}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        ) : null}

        {answer && response.delivery ? (
          <ResponseStatus
            answer={answer}
            delivery={response.delivery}
            outboxId={response.outboxId}
            lastError={response.lastError}
            onResend={() => respond(answer.ackStatus, answer.etaMinutes ?? undefined)}
          />
        ) : null}

        {dispatch ? (
          <View>
            <Text
              numberOfLines={narrativeExpanded ? undefined : 3}
              style={{ color: theme.fg, fontSize: typeScale.body.size, lineHeight: 22 }}
            >
              {dispatch.narrative || 'No narrative was sent with this dispatch.'}
            </Text>
            {dispatch.narrative && dispatch.narrative.length > 120 ? (
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={
                  narrativeExpanded ? 'Show less narrative' : 'Show the full narrative'
                }
                accessibilityState={{ expanded: narrativeExpanded }}
                onPress={() => setNarrativeExpanded((value) => !value)}
                style={{ minHeight: 48, justifyContent: 'center' }}
              >
                <Text
                  style={{ color: theme.fg, fontWeight: '700', textDecorationLine: 'underline' }}
                >
                  {narrativeExpanded ? 'Less' : 'More'}
                </Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : status === 'loading' ? (
          <Text
            accessibilityLiveRegion="polite"
            style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}
          >
            Loading the dispatch narrative…
          </Text>
        ) : null}

        {status === 'failed' && failure ? (
          <View
            accessibilityLiveRegion="polite"
            style={{
              padding: spacing.md,
              borderRadius: radius.default,
              borderWidth: 2,
              borderColor: chips.warning.onFill,
              backgroundColor: chips.warning.fill,
              gap: spacing.sm,
            }}
          >
            <Text style={{ color: chips.warning.onFill, fontSize: typeScale.body.size }}>
              ▲ {failureText(failure, Boolean(header?.address))}
            </Text>
            {detailCachedAt ? (
              <Text style={{ color: chips.warning.onFill, fontSize: typeScale.body.size }}>
                Showing details saved on this phone at {formatClock(detailCachedAt)}.
              </Text>
            ) : null}
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Retry loading the call details"
              onPress={retry}
              style={{
                minHeight: ALERT_TARGET,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: radius.default,
                borderWidth: 2,
                borderColor: chips.warning.onFill,
              }}
            >
              <Text
                style={{
                  color: chips.warning.onFill,
                  fontSize: typeScale.heading.size,
                  fontWeight: '700',
                }}
              >
                Retry
              </Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {dispatch?.toneLadder && dispatch.toneLadder.predicateGaps.length > 0 ? (
          <View
            style={{
              padding: spacing.md,
              borderRadius: radius.default,
              borderWidth: 1,
              borderColor: theme.borderDecorative,
            }}
          >
            <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>
              Tone {dispatch.toneLadder.currentToneSequence} / {dispatch.toneLadder.status}
            </Text>
            {dispatch.toneLadder.predicateGaps.map((gap) => (
              <Text key={gap} style={{ color: theme.fg, fontSize: typeScale.body.size }}>
                {gap}
              </Text>
            ))}
          </View>
        ) : null}

        {dispatch?.mapLink ? (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Open the address in maps"
            onPress={() => void Linking.openURL(dispatch.mapLink as string)}
            style={{
              minHeight: ALERT_TARGET,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: radius.default,
              borderWidth: 2,
              borderColor: theme.borderStrong,
            }}
          >
            <Text style={{ color: theme.fg, fontSize: typeScale.heading.size, fontWeight: '700' }}>
              Open in maps
            </Text>
          </TouchableOpacity>
        ) : null}

        {dispatch ? (
          <PrePlanPanel
            prePlan={dispatch.prePlan}
            unavailable={dispatch.prePlanUnavailable === true}
            {...(dispatch.nearestHydrants ? { nearestHydrants: dispatch.nearestHydrants } : {})}
            hydrantsUnavailable={dispatch.nearestHydrantsUnavailable === true}
            hydrantsIncomplete={dispatch.nearestHydrantsIncomplete === true}
          />
        ) : null}

        <TouchableOpacity
          accessibilityRole="button"
          onPress={() => navigation.navigate('Roster', { dispatchId })}
          style={{
            minHeight: ALERT_TARGET,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: radius.default,
            borderWidth: 2,
            borderColor: theme.borderStrong,
          }}
        >
          <Text style={{ color: theme.fg, fontSize: typeScale.heading.size, fontWeight: '700' }}>
            View roster
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}
