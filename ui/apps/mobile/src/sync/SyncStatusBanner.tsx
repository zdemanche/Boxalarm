import { palette, spacing, touchTarget, typography } from '@boxalarm/design-tokens';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, Text, TouchableOpacity, useColorScheme, View } from 'react-native';
import { mockSyncRepository } from '../features/sync/mockSyncRepository';
import type { SyncItem, SyncQueueStatus } from '../features/sync/types';

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

  useEffect(() => {
    let cancelled = false;
    mockSyncRepository.getStatus().then((result) => {
      if (!cancelled) setStatus(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleRetry = (item: SyncItem) => {
    mockSyncRepository.retry(item.id).then((result) => {
      mockSyncRepository.getStatus().then(setStatus);
      AccessibilityInfo.announceForAccessibility(
        result === 'SYNCED' ? `${item.label} synced` : `${item.label} failed to sync again`,
      );
    });
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
