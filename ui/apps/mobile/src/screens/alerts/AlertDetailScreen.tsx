import { radiusScale, spacing, typeScale } from '@boxalarm/design-tokens';
import { useNavigation, useRoute, type NavigationProp } from '@react-navigation/native';
import { useCallback, useEffect, useRef, useState, type ComponentRef } from 'react';
import {
  AccessibilityInfo,
  Alert,
  AppState,
  findNodeHandle,
  Linking,
  Platform,
  Text,
  TouchableOpacity,
  View,
  type AccessibilityActionEvent,
} from 'react-native';
import { useOptionalAuth } from '../../auth/AuthContext';
import { useTheme } from '../../components/ui';
import { useAlertsRepository } from '../../features/alerts/apiAlertsRepository';
import type { AlertPayload } from '../../features/alerts/alertPayload';
import { isDeviceLocked, setAlertShowsOverLockScreen } from '../../features/alerts/alertReadiness';
import {
  ETA_CHOICES,
  sameEta,
  type EtaGiven,
  type ResponseAnswer,
} from '../../features/alerts/alertResponses';
import { formatClock, formatElapsed } from '../../features/alerts/elapsed';
import { matchNotice, PrePlanPanel } from '../../features/alerts/PrePlanPanel';
import { silenceDispatchNotification } from '../../features/alerts/pushNotificationDisplay';
import { ResponseStatus, responseDeliveryCopy } from '../../features/alerts/ResponseStatus';
import { useAlertDetail, type DetailFailure } from '../../features/alerts/useAlertDetail';
import { useAlertResponse, type ResponseDelivery } from '../../features/alerts/useAlertResponse';
import type { AlertsStackParamList } from '../../navigation/AlertsStack';
import { useOptionalConnectivity } from '../../sync/ConnectivityContext';
import {
  CanvasScrollView,
  cardSurface,
  LiveCard,
  LiveDot,
  Notice,
  noticeText,
  rowDivider,
} from './alertsUi';

// a11y-spec §1.11 alert-path targets: the primary answer is full width x 88, the others 72, with
// 16 between; every other control on this screen is at least 72.
const PRIMARY_TARGET = 88;
const ALERT_TARGET = 72;
/** a11y-spec §1.1 `type.alert.type` (24/30); the address is `type.alert.address`, 32/38. */
const INCIDENT_TYPE = { size: 24, lineHeight: 30 };

/** R3-1: an answered alert stays over the keyguard until this long passes with no touch. */
export const ALERT_LOCK_IDLE_MS = 10 * 60_000;

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
  /** The amber fill: the member's answer once given, else the suggested one (Responding). */
  filled: boolean;
  selected: boolean;
  delivery: ResponseDelivery | null;
  onPress: () => void;
}

function AnswerButton({
  answer,
  label,
  sublabel,
  height,
  filled,
  selected,
  delivery,
  onPress,
}: AnswerButtonProps) {
  const theme = useTheme();
  const ink = filled ? theme.onAccentFill : theme.fg;
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
        borderRadius: radiusScale.lg,
        backgroundColor: filled ? theme.accentFill : theme.card,
        // Selected is carried by a heavy dark ring inside the amber and the words "YOUR ANSWER",
        // not by colour alone.
        borderWidth: selected ? 4 : filled ? 0 : 2,
        borderColor: selected ? theme.onAccentFill : theme.border,
      }}
    >
      <Text style={{ color: ink, fontSize: typeScale.title.size, fontWeight: '800' }}>
        {selected ? '✓ ' : ''}
        {label}
      </Text>
      {selected ? (
        <Text style={{ color: ink, fontSize: typeScale.label.size, fontWeight: '800' }}>
          YOUR ANSWER
        </Text>
      ) : sublabel ? (
        <Text style={{ color: ink, fontSize: typeScale.label.size, fontWeight: '600' }}>
          {sublabel}
        </Text>
      ) : null}
    </TouchableOpacity>
  );
}

/** A secondary action on the alert screen: 72dp (no control here is under it, a11y-spec N1) and
 * an 18pt label - bigger than the kit button's, because this screen is read at 03:00 in gloves. */
function AlertAction({
  label,
  accessibilityLabel,
  onPress,
}: {
  label: string;
  accessibilityLabel?: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={{
        minHeight: ALERT_TARGET,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.md,
        borderRadius: radiusScale.lg,
        borderWidth: 2,
        borderColor: theme.border,
        backgroundColor: theme.card,
      }}
    >
      <Text style={{ color: theme.fg, fontSize: typeScale.heading.size, fontWeight: '700' }}>
        {label}
      </Text>
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

  // Lock screen and alarm (review CR-2). While this alert is focused it asks to stay over the
  // keyguard; turning that off belongs to the navigation-state check (lockScreenPresentation),
  // never to this screen's blur or unmount - that raced a second page arriving on a locked phone.
  // The looping alarm stops when the member does something (answers, ETA, Silence) or when the
  // alert is focused on an unlocked phone in use - never merely because a screen mounted.
  const silence = useCallback(() => {
    void silenceDispatchNotification(dispatchId);
  }, [dispatchId]);

  // Round 2 m2-2 / round 3 R3-1: an answered alert left open on a locked phone must not stay
  // over the keyguard forever (anyone could change the answer), but the member who just answered
  // still needs the address, VERIFY ADDRESS, narrative, map and ETA chips. So once the answer is
  // sent, show-over-lock is released on inactivity - the screen turns off or the app goes to the
  // background, or ALERT_LOCK_IDLE_MS passes with no touch - whichever comes first. A touch
  // restarts the idle clock. A new page's full-screen launch (native) or a new call's alert
  // screen sets it again.
  const answerSent = response.answer !== null && response.delivery === 'sent';
  const answerSentRef = useRef(answerSent);
  answerSentRef.current = answerSent;
  const releasedRef = useRef(false);
  const touchedRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!answerSent) return undefined;
    const release = () => {
      releasedRef.current = true;
      setAlertShowsOverLockScreen(false);
    };
    let timer = setTimeout(release, ALERT_LOCK_IDLE_MS);
    touchedRef.current = () => {
      if (releasedRef.current) return;
      clearTimeout(timer);
      timer = setTimeout(release, ALERT_LOCK_IDLE_MS);
    };
    // Screen off (Android pauses/stops the activity) or app left: the member is done with it.
    const subscription = AppState.addEventListener('change', (status) => {
      if (status === 'background') release();
    });
    return () => {
      clearTimeout(timer);
      subscription.remove();
      touchedRef.current = null;
    };
  }, [answerSent]);

  useEffect(() => {
    let cancelled = false;
    const onFocus = () => {
      if (!releasedRef.current) setAlertShowsOverLockScreen(true);
      if (AppState.currentState !== 'active') return;
      void isDeviceLocked().then((locked) => {
        if (!cancelled && locked === false) silence();
      });
    };
    onFocus();
    const unsubscribeFocus = navigation.addListener?.('focus', onFocus);
    return () => {
      cancelled = true;
      unsubscribeFocus?.();
    };
  }, [navigation, silence]);

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
  const respond = (answer: ResponseAnswer, eta?: EtaGiven | null) => {
    silence();
    void response.respond(answer, eta);
  };

  // R3-1: a sent answer changed to a different one while the phone is locked (someone other
  // than the member could be holding it) needs a confirm. ETA changes do not.
  const changeAnswer = (answer: ResponseAnswer) => {
    const current = response.answer;
    if (!answerSentRef.current || !current || current.ackStatus === answer) {
      respond(answer);
      return;
    }
    void isDeviceLocked().then((locked) => {
      if (locked !== true) {
        respond(answer);
        return;
      }
      Alert.alert(
        `Change your answer to ${ANSWER_NAME[answer]}?`,
        `The officer already has: ${ANSWER_NAME[current.ackStatus]}.`,
        [
          { text: 'Keep my answer', style: 'cancel' },
          { text: 'Change it', style: 'destructive', onPress: () => respond(answer) },
        ],
        { cancelable: true },
      );
    });
  };

  const onAccessibilityAction = (event: AccessibilityActionEvent) => {
    const byName: Record<string, ResponseAnswer> = {
      respond: 'RESPONDING',
      respondDirect: 'DIRECT_TO_SCENE',
      notResponding: 'NOT_RESPONDING',
    };
    const answer = byName[event.nativeEvent.actionName];
    if (answer) changeAnswer(answer);
  };

  const answer = response.answer;
  const selected = (value: ResponseAnswer) => answer?.ackStatus === value;
  // One amber answer at a time: the member's own once given, Responding until then.
  const filled = (value: ResponseAnswer) => (answer ? selected(value) : value === 'RESPONDING');
  const verify = dispatch?.prePlan ? matchNotice(dispatch.prePlan) : null;
  const time = header?.time ?? null;
  const tone = header?.toneSequence ?? null;
  const statusStrip = [
    tone ? `TONE ${tone}` : null,
    time ? `${time.kind === 'received' ? 'RECEIVED' : 'DISPATCHED'} ${formatClock(time.at)}` : null,
    time ? formatElapsed(time.at, now) : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <CanvasScrollView
      onTouchStart={() => touchedRef.current?.()}
      accessibilityLabel="Incoming call"
      accessibilityActions={[
        { name: 'respond', label: ANSWER_NAME.RESPONDING },
        { name: 'respondDirect', label: ANSWER_NAME.DIRECT_TO_SCENE },
        { name: 'notResponding', label: ANSWER_NAME.NOT_RESPONDING },
      ]}
      onAccessibilityAction={onAccessibilityAction}
    >
      {/* The call: first on screen and first in reading order (a11y-spec N1) - incident type,
          then the address, then cross streets. Nothing sits above it. */}
      <LiveCard>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          <LiveDot />
          <Text
            ref={headerRef}
            accessibilityRole="header"
            style={{
              flex: 1,
              color: theme.status.danger,
              fontSize: INCIDENT_TYPE.size,
              lineHeight: INCIDENT_TYPE.lineHeight,
              fontWeight: '800',
              letterSpacing: 0.5,
            }}
          >
            {(header?.incidentType ?? `Dispatch ${dispatchId}`).toUpperCase()}
          </Text>
        </View>
        <Text
          selectable
          style={{ color: theme.fg, fontSize: 32, lineHeight: 38, fontWeight: '800' }}
        >
          {header?.address ||
            (status === 'failed' ? 'Address not available' : 'Loading the address…')}
        </Text>
        {header?.crossStreets ? (
          <Text
            style={{
              color: theme.fg,
              fontSize: typeScale.heading.size,
              lineHeight: typeScale.heading.lineHeight,
              fontWeight: '500',
            }}
          >
            x {header.crossStreets}
          </Text>
        ) : null}

        {/* Directly under the address it qualifies (alert-ux M4), not below the buttons. */}
        {verify?.warning ? (
          <Notice tone="warning" accessibilityRole="alert">
            <Text style={noticeText(theme, 'warning', true)}>{verify.text}</Text>
          </Notice>
        ) : null}

        {dispatch?.verifyRequired ? (
          <Notice tone="warning" accessibilityRole="alert" accessibilityLiveRegion="assertive">
            <Text style={noticeText(theme, 'warning', true)}>
              VERIFY: the CAD message could not be read automatically. The location is in the
              dispatch text - confirm it by radio.
            </Text>
          </Notice>
        ) : null}

        {statusStrip ? (
          <View
            style={{
              borderTopWidth: 1,
              borderTopColor: theme.borderDecorative,
              paddingTop: spacing.sm,
              marginTop: spacing.xs,
            }}
          >
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
          </View>
        ) : null}
      </LiveCard>

      {/* a11y-spec N1 Offline: the banner sits below the header, never above the address. */}
      {!isOnline ? (
        <Notice tone="warning">
          <Text style={noticeText(theme, 'warning')}>
            You&apos;re offline. This call came through anyway - your answer will send when you have
            signal.
          </Text>
        </Notice>
      ) : null}

      {/* Answer stack: before the narrative, so a driving member reaches it first (N1 #3). */}
      <View style={cardSurface(theme)}>
        <View style={{ gap: spacing.md }}>
          <AnswerButton
            answer="RESPONDING"
            label="RESPONDING"
            sublabel="to the station"
            height={PRIMARY_TARGET}
            filled={filled('RESPONDING')}
            selected={selected('RESPONDING')}
            delivery={response.delivery}
            onPress={() => changeAnswer('RESPONDING')}
          />
          <AnswerButton
            answer="DIRECT_TO_SCENE"
            label="DIRECT TO SCENE"
            height={ALERT_TARGET}
            filled={filled('DIRECT_TO_SCENE')}
            selected={selected('DIRECT_TO_SCENE')}
            delivery={response.delivery}
            onPress={() => changeAnswer('DIRECT_TO_SCENE')}
          />
          <AnswerButton
            answer="NOT_RESPONDING"
            label="NOT RESPONDING"
            height={ALERT_TARGET}
            filled={filled('NOT_RESPONDING')}
            selected={selected('NOT_RESPONDING')}
            delivery={response.delivery}
            onPress={() => changeAnswer('NOT_RESPONDING')}
          />

          {Platform.OS === 'android' ? (
            <AlertAction
              label="Silence alarm"
              accessibilityLabel="Silence the alarm without answering"
              onPress={() => {
                silence();
                AccessibilityInfo.announceForAccessibility(
                  'Alarm silenced. You have not answered yet.',
                );
              }}
            />
          ) : null}
        </View>

        {answer && answer.ackStatus !== 'NOT_RESPONDING' ? (
          <View
            accessibilityRole="radiogroup"
            accessibilityLabel="Your ETA"
            style={{
              gap: spacing.sm,
              marginTop: spacing.sm,
              paddingTop: spacing.md,
              borderTopWidth: 1,
              borderTopColor: theme.borderDecorative,
            }}
          >
            <Text style={{ color: theme.fg, fontSize: typeScale.heading.size, fontWeight: '700' }}>
              {answer.eta ? 'Your ETA - tap to change' : 'ETA ? - tap one if you can (optional)'}
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
              {ETA_CHOICES.map((choice) => {
                const isSelected = sameEta(answer.eta, choice);
                const wide = choice.qualifier === 'AT_STATION';
                return (
                  <TouchableOpacity
                    key={choice.id}
                    accessibilityRole="radio"
                    accessibilityLabel={choice.spoken}
                    accessibilityState={{ selected: isSelected, checked: isSelected }}
                    onPress={() =>
                      respond(answer.ackStatus, {
                        minutes: choice.minutes,
                        qualifier: choice.qualifier,
                      })
                    }
                    style={{
                      flexGrow: 1,
                      flexBasis: wide ? '100%' : '20%',
                      minHeight: ALERT_TARGET,
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: radiusScale.lg,
                      // Selected: the amber fill under dark text, with a heavy dark ring.
                      borderWidth: isSelected ? 4 : 1,
                      borderColor: isSelected ? theme.onAccentFill : theme.border,
                      backgroundColor: isSelected ? theme.accentFill : theme.surface,
                    }}
                  >
                    <Text
                      style={{
                        color: isSelected ? theme.onAccentFill : theme.fg,
                        fontSize: typeScale.title.size,
                        fontWeight: '800',
                      }}
                    >
                      {choice.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        ) : null}
      </View>

      {answer && response.delivery ? (
        <ResponseStatus
          answer={answer}
          delivery={response.delivery}
          outboxId={response.outboxId}
          lastError={response.lastError}
          rosterAnswer={response.rosterAnswer}
          onResend={() => respond(answer.ackStatus, answer.eta)}
          onKeepRoster={() => void response.keepRosterAnswer()}
        />
      ) : null}

      {dispatch || status === 'loading' ? (
        <View style={cardSurface(theme)}>
          {dispatch ? (
            <View>
              <Text
                numberOfLines={narrativeExpanded ? undefined : 3}
                style={{ color: theme.fg, fontSize: 17, lineHeight: 24 }}
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
                  style={{ minHeight: ALERT_TARGET, justifyContent: 'center' }}
                >
                  <Text
                    style={{
                      color: theme.accent,
                      fontSize: typeScale.heading.size,
                      fontWeight: '700',
                    }}
                  >
                    {narrativeExpanded ? 'Less' : 'More'}
                  </Text>
                </TouchableOpacity>
              ) : null}
            </View>
          ) : (
            <Text
              accessibilityLiveRegion="polite"
              style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}
            >
              Loading the dispatch narrative…
            </Text>
          )}
        </View>
      ) : null}

      {dispatch?.updates && dispatch.updates.length > 0 ? (
        <View
          accessibilityLabel={`CAD updates, ${dispatch.updates.length}`}
          style={cardSurface(theme)}
        >
          <Text
            accessibilityRole="header"
            style={{ color: theme.fg, fontSize: typeScale.heading.size, fontWeight: '700' }}
          >
            CAD updates
          </Text>
          {dispatch.updates.map((update, index) => (
            <Text
              key={update.updateId}
              style={{
                color: theme.fg,
                fontSize: typeScale.body.size,
                lineHeight: 22,
                ...rowDivider(theme, index),
              }}
            >
              {new Date(update.receivedAt * 1000).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}{' '}
              — {update.summary}
            </Text>
          ))}
        </View>
      ) : null}

      {status === 'failed' && failure ? (
        <Notice tone="warning" accessibilityLiveRegion="polite">
          <Text style={noticeText(theme, 'warning')}>
            {failureText(failure, Boolean(header?.address))}
          </Text>
          {detailCachedAt ? (
            <Text style={noticeText(theme, 'warning')}>
              Showing details saved on this phone at {formatClock(detailCachedAt)}.
            </Text>
          ) : null}
          <AlertAction
            label="Retry"
            accessibilityLabel="Retry loading the call details"
            onPress={retry}
          />
        </Notice>
      ) : null}

      {dispatch?.toneLadder && dispatch.toneLadder.predicateGaps.length > 0 ? (
        <View style={cardSurface(theme)}>
          <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>
            Tone {dispatch.toneLadder.currentToneSequence} / {dispatch.toneLadder.status}
          </Text>
          {dispatch.toneLadder.predicateGaps.map((gap) => (
            <Text key={gap} style={{ color: theme.fg, fontSize: 17, fontWeight: '600' }}>
              {gap}
            </Text>
          ))}
        </View>
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

      {/* a11y-spec §3.1 #3: pre-plan and hydrants, then the map hand-off. */}
      <View style={[cardSurface(theme), { gap: spacing.md }]}>
        {dispatch?.mapLink ? (
          <AlertAction
            label="Open in maps"
            accessibilityLabel="Open the address in maps"
            onPress={() => void Linking.openURL(dispatch.mapLink as string)}
          />
        ) : null}
        <AlertAction
          label="View roster"
          onPress={() => navigation.navigate('Roster', { dispatchId })}
        />
      </View>
    </CanvasScrollView>
  );
}
