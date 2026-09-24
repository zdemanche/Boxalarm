import { palette, spacing, typography } from '@boxalarm/design-tokens';
import { useEffect, useState } from 'react';
import Config from 'react-native-config';
import { FlatList, Text, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useOptionalAuth } from '../../auth/AuthContext';
import { getCertifications } from '../../features/training/api';
import {
  certificationStatusColor,
  certificationStatusLabel,
} from '../../features/me/certificationStatus';
import { mockMeRepository } from '../../features/me/mockMeRepository';
import type { Certification } from '../../features/me/types';

export function CertificationsScreen() {
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;
  const auth = useOptionalAuth();
  const apiBaseUrl = Config.API_BASE_URL;
  const [certifications, setCertifications] = useState<Certification[]>([]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (auth?.isAuthenticated && apiBaseUrl && auth.memberId) {
        try {
          const result = await getCertifications(auth, apiBaseUrl, auth.memberId);
          if (!cancelled) setCertifications(result);
          return;
        } catch {
          // Falls through to the local mock below.
        }
      }
      const fallback = await mockMeRepository.getCertifications();
      if (!cancelled) setCertifications(fallback);
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [auth, apiBaseUrl]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
      <FlatList
        data={certifications}
        keyExtractor={(item) => item.certId}
        contentContainerStyle={{ padding: spacing.lg }}
        renderItem={({ item }) => (
          <View
            style={{
              paddingVertical: spacing.md,
              borderBottomWidth: 1,
              borderBottomColor: tokens.foreground + '22',
            }}
          >
            <Text
              style={{
                color: tokens.foreground,
                fontSize: typography.size.base,
                fontWeight: '600',
              }}
            >
              {item.certType}
            </Text>
            <Text
              style={{
                color: tokens.foreground,
                opacity: 0.7,
                fontSize: typography.size.sm,
                marginTop: 2,
              }}
            >
              {item.issuingAuthority} · expires {item.expiryDate}
            </Text>
            <Text
              style={{
                color: certificationStatusColor(item.status, tokens),
                fontSize: typography.size.sm,
                fontWeight: '600',
                marginTop: spacing.xs,
              }}
            >
              {certificationStatusLabel(item.status)}
            </Text>
          </View>
        )}
      />
    </SafeAreaView>
  );
}
