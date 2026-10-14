import { spacing, typeScale, type StatusRole } from '@boxalarm/design-tokens';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useOptionalAuth } from '../../auth/AuthContext';
import { kvGet, kvSet } from '../../sync/kvStore';
import { memberCacheKey } from '../../sync/memberCache';
import { AccessibilityInfo, Platform, Text, View } from 'react-native';
import { Button, Card, Screen, StatusChip, useTheme } from '../../components/ui';
import { useAlertsRepository } from '../../features/alerts/apiAlertsRepository';
import type { SelfTestRun } from '../../features/alerts/types';
import {
  useAlertReadiness,
  type ReadinessItem,
  type ReadinessStatus,
} from '../../features/alerts/useAlertReadiness';
import { ROW_TITLE_SIZE, Rows } from './MeRows';

const POLL_INTERVAL_MS = 1_500;
const MAX_POLLS = 20;

const CHANNEL_LABEL: Record<string, string> = { PUSH: 'Push', SMS: 'SMS', VOICE: 'Voice' };

interface LastSelfTest {
  testId: string | null;
  rang: 'yes' | 'no';
  /** Epoch ms. */
  at: number;
}

const READINESS_CHIP: Record<ReadinessStatus, { role: StatusRole; label: string }> = {
  ok: { role: 'ok', label: 'Ready' },
  fail: { role: 'danger', label: 'Fix' },
  warn: { role: 'caution', label: 'Check' },
  unknown: { role: 'neutral', label: 'Unknown' },
};

function formatTimestamp(seconds: number): string {
  return new Date(seconds * 1000).toLocaleTimeString();
}

function ReadinessRow({ item }: { item: ReadinessItem }) {
  const theme = useTheme();
  const chip = READINESS_CHIP[item.status];
  return (
    <View style={{ minHeight: 72, paddingVertical: spacing.md, gap: spacing.sm }}>
      {/* Chip before the name, as before: a screen reader hears the verdict first. */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <StatusChip status={chip.role} label={chip.label} />
        <Text style={{ color: theme.fg, fontSize: ROW_TITLE_SIZE, fontWeight: '600', flex: 1 }}>
          {item.label}
        </Text>
      </View>
      <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>{item.detail}</Text>
      {item.status !== 'ok' && item.fix ? (
        <Button
          label={item.fixLabel ?? 'Fix'}
          variant={item.status === 'fail' ? 'danger' : 'secondary'}
          accessibilityLabel={`${item.fixLabel ?? 'Fix'}: ${item.label}`}
          onPress={item.fix}
        />
      ) : null}
    </View>
  );
}

// F-15 / a11y-spec N4: (1) the device readiness checklist, evaluated locally and offline, then
// (2) a real test page through the real fan-out, then the only question that proves anything:
// did the phone actually ring? Server-side "delivered" says nothing about the volume switch,
// Do Not Disturb, or a Sleep Focus. Canary-safe: never touches alert history or the roster.
export function SelfTestScreen() {
  const theme = useTheme();
  const repository = useAlertsRepository();
  const readiness = useAlertReadiness();
  // Per member (m6): "this phone last rang" for the previous member says nothing about whether
  // this phone is registered for the member signed in now.
  const lastSelfTestKey = memberCacheKey.lastSelfTest(useOptionalAuth()?.memberId ?? null);
  const [run, setRun] = useState<SelfTestRun | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rang, setRang] = useState<'yes' | 'no' | null>(null);
  // The server never settled the run (poll error or MAX_POLLS): the ring question is still asked -
  // whether the phone rang is the point of the test (review m13).
  const [timedOut, setTimedOut] = useState(false);
  const [last, setLast] = useState<LastSelfTest | null>(null);
  const testIdRef = useRef<string | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    void kvGet<LastSelfTest>(lastSelfTestKey).then((entry) => {
      if (!cancelledRef.current && entry) setLast(entry.value);
    });
    return () => {
      cancelledRef.current = true;
    };
  }, [lastSelfTestKey]);

  const poll = useCallback(
    async (testId: string, attempt: number) => {
      if (cancelledRef.current) return;
      let result: SelfTestRun;
      try {
        result = await repository.getSelfTestRun(testId);
      } catch (pollError) {
        console.warn('[self-test] reading the test result failed', pollError);
        if (cancelledRef.current) return;
        setRunning(false);
        setTimedOut(true);
        setError(
          "Lost track of the test result - the server didn't answer. Whether your phone rang is what matters: answer below.",
        );
        return;
      }
      if (cancelledRef.current) return;
      setRun(result);
      if (result.overallResult === 'RUNNING' && attempt < MAX_POLLS) {
        setTimeout(() => void poll(testId, attempt + 1), POLL_INTERVAL_MS);
        return;
      }
      setRunning(false);
      if (result.overallResult === 'RUNNING') setTimedOut(true);
      AccessibilityInfo.announceForAccessibility(
        result.overallResult === 'PASS'
          ? 'Test page sent on every channel. Did your phone ring?'
          : result.overallResult === 'RUNNING'
            ? 'No final result from the server. Did your phone ring?'
            : 'Test failed on at least one channel. Check the results below.',
      );
    },
    [repository],
  );

  const runSelfTest = async () => {
    setRunning(true);
    setError(null);
    setRun(null);
    setRang(null);
    setTimedOut(false);
    try {
      const { testId } = await repository.triggerSelfTest();
      testIdRef.current = testId;
      await poll(testId, 0);
    } catch {
      setRunning(false);
      setError('Could not start the self-test. Try again.');
    }
  };

  const answerRang = (answer: 'yes' | 'no') => {
    setRang(answer);
    // Kept on the phone so the member (and a later support conversation) can see when this phone
    // last proved it rings. Not reported to the server - there is no endpoint for it yet.
    const record: LastSelfTest = { testId: testIdRef.current, rang: answer, at: Date.now() };
    setLast(record);
    void kvSet(lastSelfTestKey, record);
    AccessibilityInfo.announceForAccessibility(
      answer === 'yes'
        ? 'Good. This phone rang for a test page.'
        : 'This phone did not ring. Follow the steps below before your next call.',
    );
  };

  const failing = (readiness.items ?? []).filter((item) => item.status !== 'ok');
  const finished = timedOut || (run !== null && run.overallResult !== 'RUNNING');

  const bodyText = { color: theme.fg, fontSize: typeScale.body.size };

  return (
    <Screen>
      <Card title="Is this phone ready?">
        {readiness.items === null ? (
          <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>
            Checking this phone…
          </Text>
        ) : (
          <View accessibilityLiveRegion="polite">
            <Rows>
              {readiness.items.map((item) => (
                <ReadinessRow key={item.id} item={item} />
              ))}
            </Rows>
          </View>
        )}
      </Card>

      <Card title="Send a test page">
        <Text style={bodyText}>
          Sends a test page - marked as a test, not a real call - through the same path as a real
          one, on every channel. Put the phone down the way you leave it at night, then check it
          rang.
        </Text>
        {last ? (
          <Text
            style={{
              color: last.rang === 'yes' ? theme.status.ok : theme.status.danger,
              fontSize: typeScale.body.size,
              fontWeight: '700',
            }}
          >
            Last test {new Date(last.at).toLocaleString()}:{' '}
            {last.rang === 'yes' ? 'this phone rang.' : 'this phone did NOT ring.'}
          </Text>
        ) : null}
        <View style={{ marginTop: spacing.sm }}>
          <Button
            label={running ? 'Running…' : 'Run self-test'}
            accessibilityLabel="Run self-test"
            size="alert"
            fullWidth
            loading={running}
            onPress={() => void runSelfTest()}
          />
        </View>

        {error ? (
          <Text
            accessibilityRole="alert"
            style={{ color: theme.status.danger, fontSize: typeScale.body.size }}
          >
            {error}
          </Text>
        ) : null}

        {run ? (
          <View accessibilityLiveRegion="polite" style={{ marginTop: spacing.sm }}>
            <Rows>
              {run.channelsTested.map((channel) => {
                const result = run.channelResults[channel];
                const status = !result ? 'Running…' : result.ok ? 'Pass' : 'Fail';
                return (
                  <View key={channel} style={{ paddingVertical: spacing.sm, gap: 2 }}>
                    <Text
                      style={{
                        color: !result
                          ? theme.fg
                          : result.ok
                            ? theme.status.ok
                            : theme.status.danger,
                        fontSize: ROW_TITLE_SIZE,
                        fontWeight: '600',
                      }}
                    >
                      {CHANNEL_LABEL[channel] ?? channel}: {status}
                      {run.runAt ? ` · ${formatTimestamp(run.runAt)}` : ''}
                    </Text>
                    {result && !result.ok && result.reason ? (
                      <Text style={{ color: theme.status.danger, fontSize: typeScale.body.size }}>
                        {channel.toLowerCase()}: {result.reason}
                      </Text>
                    ) : null}
                  </View>
                );
              })}
            </Rows>
          </View>
        ) : null}
      </Card>

      {finished ? (
        <Card title="Did your phone ring?">
          <View style={{ gap: spacing.md }}>
            <View
              accessibilityRole="radiogroup"
              accessibilityLabel="Did your phone ring?"
              style={{ gap: spacing.md }}
            >
              <Button
                label="Yes, it rang"
                size="alert"
                fullWidth
                variant={rang === 'yes' ? 'primary' : 'secondary'}
                selected={rang === 'yes'}
                onPress={() => answerRang('yes')}
              />
              <Button
                label="No, it didn't ring"
                size="alert"
                fullWidth
                variant={rang === 'no' ? 'danger' : 'secondary'}
                selected={rang === 'no'}
                onPress={() => answerRang('no')}
              />
            </View>
            {rang === 'yes' ? (
              <StatusChip status="ok" label="This phone rang for a test page" />
            ) : null}
            {rang === 'no' ? (
              <View accessibilityRole="alert" style={{ gap: spacing.sm }}>
                <StatusChip status="danger" label="This phone did not ring" />
                <Text style={bodyText}>You may not hear a real page. Before your next call:</Text>
                {failing.map((item) => (
                  <Text key={item.id} style={bodyText}>
                    • Fix &quot;{item.label}&quot; above.
                  </Text>
                ))}
                <Text style={bodyText}>
                  •{' '}
                  {Platform.OS === 'ios'
                    ? 'Set the ring/silent switch to ring, turn the ringer volume up, and allow Boxalarm in every Focus (Sleep, Do Not Disturb).'
                    : 'Turn the alarm volume up - pages ring on the alarm volume, not the ringer - and check Bedtime / Do Not Disturb lets Boxalarm through.'}
                </Text>
                <Text style={bodyText}>
                  • Run the test again. If it still doesn't ring, tell your officer - text and voice
                  pages still reach you, and radio tone-out is unchanged.
                </Text>
              </View>
            ) : null}
          </View>
        </Card>
      ) : null}
    </Screen>
  );
}
