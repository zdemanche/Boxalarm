import { typeScale } from '@boxalarm/design-tokens';
import { useEffect, useState } from 'react';
import Config from 'react-native-config';
import { Text } from 'react-native';
import { useOptionalAuth } from '../../auth/AuthContext';
import { Card, Screen, useTheme } from '../../components/ui';
import { getCertifications } from '../../features/training/api';
import { ApiError } from '../../lib/apiClient';
import { mockMeRepository } from '../../features/me/mockMeRepository';
import type { Certification } from '../../features/me/types';
import { CertificationChip, InfoRow, Rows } from './MeRows';

export function CertificationsScreen() {
  const theme = useTheme();
  const auth = useOptionalAuth();
  const apiBaseUrl = Config.API_BASE_URL;
  const [certifications, setCertifications] = useState<Certification[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSampleData, setIsSampleData] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoadError(null);
      if (auth?.isAuthenticated && apiBaseUrl && auth.memberId) {
        // A signed-in member never sees the mock certifications: a 401/403 or any other failure
        // is shown as an error, so a revoked member can't mistake sample data for their own
        // credentials (PR #321 review M6).
        try {
          const result = await getCertifications(auth, apiBaseUrl, auth.memberId);
          if (!cancelled) {
            setIsSampleData(false);
            setCertifications(result);
          }
        } catch (error) {
          if (cancelled) return;
          setCertifications([]);
          setLoadError(
            error instanceof ApiError &&
              (error.problem.status === 401 || error.problem.status === 403)
              ? 'You do not have access to these certifications.'
              : 'Certifications could not be loaded. Check your connection and try again.',
          );
        }
        return;
      }
      // Not signed in / no API configured (local dev, demo): sample data, labelled as such.
      const fallback = await mockMeRepository.getCertifications();
      if (!cancelled) {
        setIsSampleData(true);
        setCertifications(fallback);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [auth, apiBaseUrl]);

  return (
    <Screen>
      {isSampleData ? (
        <Text style={{ color: theme.fgMuted, fontSize: typeScale.bodyDense.size }}>
          Sample data. Sign in to see your certifications.
        </Text>
      ) : null}
      {loadError ? (
        <Card>
          <Text
            accessibilityRole="alert"
            style={{ color: theme.status.danger, fontSize: typeScale.body.size }}
          >
            {loadError}
          </Text>
        </Card>
      ) : null}
      {certifications.length > 0 ? (
        <Card>
          <Rows>
            {certifications.map((item) => (
              <InfoRow
                key={item.certId}
                title={item.certType}
                detail={`${item.issuingAuthority} · expires ${item.expiryDate}`}
                trailing={<CertificationChip status={item.status} />}
              />
            ))}
          </Rows>
        </Card>
      ) : null}
    </Screen>
  );
}
