import { palette, spacing, typography } from '@boxalarm/design-tokens';
import { useEffect, useState } from 'react';
import { FlatList, Text, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  certificationStatusColor,
  certificationStatusLabel,
} from '../../features/me/certificationStatus';
import { mockMeRepository } from '../../features/me/mockMeRepository';
import type { Certification } from '../../features/me/types';

export function CertificationsScreen() {
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;
  const [certifications, setCertifications] = useState<Certification[]>([]);

  useEffect(() => {
    let cancelled = false;
    mockMeRepository.getCertifications().then((result) => {
      if (!cancelled) setCertifications(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
