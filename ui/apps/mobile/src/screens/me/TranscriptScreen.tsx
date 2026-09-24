import { palette, spacing, touchTarget, typography } from '@boxalarm/design-tokens';
import { useEffect, useState } from 'react';
import Config from 'react-native-config';
import { ScrollView, Share, Text, TouchableOpacity, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useOptionalAuth } from '../../auth/AuthContext';
import { getTranscript } from '../../features/training/api';
import type { Transcript } from '../../features/training/types';

function toCsv(transcript: Transcript): string {
  const lines = ['certType,status,expiryDate'];
  for (const cert of transcript.certifications) {
    lines.push(`${cert.certType},${cert.status},${cert.expiryDate}`);
  }
  lines.push('', 'category,hours');
  for (const [category, hours] of Object.entries(transcript.hoursByCategory)) {
    lines.push(`${category},${hours}`);
  }
  return lines.join('\n');
}

export function TranscriptScreen() {
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;
  const auth = useOptionalAuth();
  const apiBaseUrl = Config.API_BASE_URL;
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!auth?.isAuthenticated || !apiBaseUrl || !auth.memberId) return;
    setLoadError(null);
    getTranscript(auth, apiBaseUrl, auth.memberId)
      .then((result) => {
        if (!cancelled) setTranscript(result);
      })
      .catch(() => {
        if (!cancelled) {
          setLoadError('Transcript could not be loaded. Check your connection and try again.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [auth, apiBaseUrl]);

  const hasHistory =
    transcript && (transcript.certifications.length > 0 || transcript.attendance.length > 0);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg }}>
        <Text
          accessibilityRole="header"
          style={{ color: tokens.foreground, fontSize: typography.size.xl, fontWeight: '700' }}
        >
          Transcript
        </Text>

        {loadError ? (
          <Text
            accessibilityRole="alert"
            style={{
              color: tokens.error,
              fontSize: typography.size.sm,
              marginTop: spacing.md,
            }}
          >
            {loadError}
          </Text>
        ) : null}

        {transcript ? (
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => void Share.share({ message: toCsv(transcript) })}
            style={{
              minHeight: touchTarget.baseline.ios,
              justifyContent: 'center',
              marginTop: spacing.md,
            }}
          >
            <Text style={{ color: tokens.accent, fontSize: typography.size.base }}>
              Share transcript (CSV)
            </Text>
          </TouchableOpacity>
        ) : null}

        {!hasHistory ? (
          <Text style={{ color: tokens.foreground, opacity: 0.7, marginTop: spacing.lg }}>
            No training history on file.
          </Text>
        ) : (
          <>
            {transcript?.certifications.map((cert) => (
              <View key={cert.certId} style={{ marginTop: spacing.md }}>
                <Text style={{ color: tokens.foreground, fontSize: typography.size.base }}>
                  {cert.certType} — {cert.status}
                </Text>
              </View>
            ))}
            {transcript &&
              Object.entries(transcript.hoursByCategory).map(([category, hours]) => (
                <View key={category} style={{ marginTop: spacing.xs }}>
                  <Text
                    style={{
                      color: tokens.foreground,
                      opacity: 0.7,
                      fontSize: typography.size.sm,
                    }}
                  >
                    {category}: {hours}h
                  </Text>
                </View>
              ))}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
