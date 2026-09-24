import { palette, spacing, touchTarget, typography } from '@boxalarm/design-tokens';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, Text, TouchableOpacity, useColorScheme, View } from 'react-native';
import type { SyncItem, SyncQueueStatus } from '../features/sync/types';
import * as syncManager from './syncManager';

function formatRelative(iso: string | null): string {
  if (!iso) return 'never';
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return 'just now';
  return `${minutes} min ago`;
}

// architecture.md's sync engine section: a persistent, dismissible banner shows queued-item
// count and last-sync time; a failed item surfaces its own retry action and is never silently
// dropped - so dismissal is blocked while any item is FAILED, matching F7.7's "never silently
// dropped" rule applied to the write side.
export function SyncStatusBanner() {
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;
  const [status, setStatus] = useState<SyncQueueStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => syncManager.subscribe(setStatus), []);

  // The retry outcome (synced vs. failed again) only settles once the drain finishes, and the
  // status re-render above already carries that outcome for every viewer - so this announces
  // the action taken, not a guessed result, and stays correct whichever way the retry resolves.
  const handleRetry = (item: SyncItem) => {
    AccessibilityInfo.announceForAccessibility(`Retrying ${item.label}`);
    void syncManager.retry(item.id);
  };

  if (!status || dismissed) return null;

  const failed = status.items.filter((item) => item.status === 'FAILED');
  const pending = status.items.filter((item) => item.status !== 'FAILED');
  const hasFailed = failed.length > 0;

  return (
    <View
      style={{
        backgroundColor: hasFailed
          ? tokens.error + '22'
          : pending.length > 0
            ? tokens.accent + '22'
            : tokens.foreground + '11',
        padding: spacing.sm,
        borderBottomWidth: 1,
        borderBottomColor: tokens.foreground + '22',
      }}
    >
      {pending.length > 0 && (
        <Text style={{ color: tokens.foreground, fontSize: typography.size.sm }}>
          {pending.length} item{pending.length === 1 ? '' : 's'} waiting to sync
        </Text>
      )}
      {failed.map((item) => (
        <View
          key={item.id}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: spacing.xs,
          }}
        >
          <Text style={{ color: tokens.error, fontSize: typography.size.sm, flexShrink: 1 }}>
            {item.label} failed to sync
          </Text>
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => handleRetry(item)}
            style={{
              minHeight: touchTarget.baseline.ios,
              justifyContent: 'center',
              paddingHorizontal: spacing.sm,
            }}
          >
            <Text style={{ color: tokens.error, fontWeight: '600', fontSize: typography.size.sm }}>
              Retry
            </Text>
          </TouchableOpacity>
        </View>
      ))}
      {!hasFailed && pending.length === 0 && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Text style={{ color: tokens.foreground, opacity: 0.7, fontSize: typography.size.sm }}>
            Synced {formatRelative(status.lastSyncAt)}
          </Text>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
            onPress={() => setDismissed(true)}
            style={{
              minHeight: touchTarget.baseline.ios,
              justifyContent: 'center',
              paddingHorizontal: spacing.sm,
            }}
          >
            <Text style={{ color: tokens.foreground, fontSize: typography.size.sm }}>Dismiss</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}
