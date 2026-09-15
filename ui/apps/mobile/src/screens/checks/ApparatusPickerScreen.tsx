import { palette, spacing, touchTarget, typography } from '@boxalarm/design-tokens';
import { useNavigation, type NavigationProp } from '@react-navigation/native';
import { useEffect, useState } from 'react';
import { FlatList, Text, TouchableOpacity, useColorScheme } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useChecksRepository } from '../../features/checks/apiChecksRepository';
import type { Apparatus } from '../../features/checks/types';
import type { ChecksStackParamList } from '../../navigation/ChecksStack';

export function ApparatusPickerScreen() {
  const navigation = useNavigation<NavigationProp<ChecksStackParamList>>();
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;
  const repository = useChecksRepository();
  const [apparatus, setApparatus] = useState<Apparatus[]>([]);

  useEffect(() => {
    let cancelled = false;
    repository.getApparatus().then((result) => {
      if (!cancelled) setApparatus(result);
    });
    return () => {
      cancelled = true;
    };
  }, [repository]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
      <FlatList
        data={apparatus}
        keyExtractor={(item) => item.apparatusId}
        contentContainerStyle={{ padding: spacing.lg }}
        renderItem={({ item }) => {
          const inService = item.status === 'IN_SERVICE';
          return (
            <TouchableOpacity
              accessibilityRole="button"
              disabled={!inService}
              onPress={() => navigation.navigate('CheckRunner', { apparatusId: item.apparatusId })}
              style={{
                minHeight: touchTarget.baseline.ios,
                justifyContent: 'center',
                paddingVertical: spacing.md,
                paddingHorizontal: spacing.md,
                opacity: inService ? 1 : 0.5,
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
                {item.unitId}
              </Text>
              <Text
                style={{
                  color: inService ? tokens.success : tokens.error,
                  fontSize: typography.size.sm,
                  marginTop: 2,
                }}
              >
                {inService ? 'In service' : 'Out of service'}
              </Text>
            </TouchableOpacity>
          );
        }}
      />
    </SafeAreaView>
  );
}
