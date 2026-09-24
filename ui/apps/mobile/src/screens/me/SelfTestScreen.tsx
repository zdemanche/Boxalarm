import { palette, radius, spacing, touchTarget, typography } from '@boxalarm/design-tokens';
import { useCallback, useRef, useState } from 'react';
import { AccessibilityInfo, Text, TouchableOpacity, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAlertsRepository } from '../../features/alerts/apiAlertsRepository';
import type { SelfTestRun } from '../../features/alerts/types';

const POLL_INTERVAL_MS = 1_500;
const MAX_POLLS = 20;

const CHANNEL_LABEL: Record<string, string> = { PUSH: 'Push', SMS: 'SMS', VOICE: 'Voice' };

function formatTimestamp(seconds: number): string {
  return new Date(seconds * 1000).toLocaleTimeString();
}

// E1-S8-UI: the one real "Test my alert path" flow, reachable from the Me tab. Consolidated -
// the Alerts tab no longer has its own self-test entry point. Canary-safe: this never touches
// the member's alert history or any roster view (it is not fetched by either screen).
export function SelfTestScreen() {
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;
  const repository = useAlertsRepository();
  const [run, setRun] = useState<SelfTestRun | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const poll = useCallback(
    async (testId: string, attempt: number) => {
      if (cancelledRef.current) return;
      const result = await repository.getSelfTestRun(testId);
      setRun(result);
      if (result.overallResult === 'RUNNING' && attempt < MAX_POLLS) {
        setTimeout(() => void poll(testId, attempt + 1), POLL_INTERVAL_MS);
        return;
      }
      setRunning(false);
      AccessibilityInfo.announceForAccessibility(
        result.overallResult === 'PASS'
          ? 'Self-test complete. All channels passed.'
          : 'Self-test complete. Check the results below.',
      );
    },
    [repository],
  );

  const runSelfTest = async () => {
    setRunning(true);
    setError(null);
    setRun(null);
    try {
      const { testId } = await repository.triggerSelfTest();
      await poll(testId, 0);
    } catch {
      setRunning(false);
      setError('Could not start the self-test. Try again.');
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background, padding: spacing.lg }}>
      <Text
        accessibilityRole="header"
        style={{ color: tokens.foreground, fontSize: typography.size.lg, fontWeight: '700' }}
      >
        Test my alert path
      </Text>
      <Text
        style={{
          color: tokens.foreground,
          opacity: 0.7,
          fontSize: typography.size.base,
          marginTop: spacing.sm,
          marginBottom: spacing.lg,
        }}
      >
        Sends a synthetic dispatch through the same fan-out path as a real alert and shows what
        arrived on each channel.
      </Text>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Run self-test"
        disabled={running}
        onPress={() => void runSelfTest()}
        style={{
          minHeight: touchTarget.baseline.ios,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: tokens.accent,
          borderRadius: radius.default,
          paddingHorizontal: spacing.lg,
          opacity: running ? 0.6 : 1,
        }}
      >
        <Text
          style={{ color: tokens.background, fontSize: typography.size.base, fontWeight: '600' }}
        >
          {running ? 'Running…' : 'Run self-test'}
        </Text>
      </TouchableOpacity>

      {error ? (
        <Text
          accessibilityRole="alert"
          style={{ color: tokens.error, fontSize: typography.size.base, marginTop: spacing.lg }}
        >
          {error}
        </Text>
      ) : null}

      {run ? (
        <View accessibilityLiveRegion="polite" style={{ marginTop: spacing.lg }}>
          {run.channelsTested.map((channel) => {
            const result = run.channelResults[channel];
            const status = !result ? 'Running…' : result.ok ? 'Pass' : 'Fail';
            return (
              <View key={channel} style={{ marginTop: spacing.sm }}>
                <Text
                  style={{
                    color: !result ? tokens.foreground : result.ok ? tokens.success : tokens.error,
                    fontSize: typography.size.base,
                    fontWeight: '600',
                  }}
                >
                  {CHANNEL_LABEL[channel] ?? channel}: {status}
                  {run.runAt ? ` · ${formatTimestamp(run.runAt)}` : ''}
                </Text>
                {result && !result.ok && result.reason ? (
                  <Text style={{ color: tokens.error, fontSize: typography.size.sm }}>
                    {channel.toLowerCase()}: {result.reason}
                  </Text>
                ) : null}
              </View>
            );
          })}
        </View>
      ) : null}
    </SafeAreaView>
  );
}
