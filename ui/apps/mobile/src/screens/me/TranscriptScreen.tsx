import { typeScale } from '@boxalarm/design-tokens';
import { useEffect, useState } from 'react';
import Config from 'react-native-config';
import { Share, Text } from 'react-native';
import { useOptionalAuth } from '../../auth/AuthContext';
import { Button, Card, Screen, useTheme } from '../../components/ui';
import { certificationStatusLabel } from '../../features/me/certificationStatus';
import { getTranscript } from '../../features/training/api';
import type { Transcript } from '../../features/training/types';
import { CertificationChip, InfoRow, ROW_TITLE_SIZE, Rows } from './MeRows';

const FORMULA_PREFIX_PATTERN = /^[=+\-@]/;

// Quote fields containing a delimiter/quote/newline, and defuse a leading =, +, -, or @ (CSV
// injection: those trigger formula evaluation in Excel/Sheets/Numbers when the file is opened)
// by prefixing with a single quote before applying the standard escaping.
function csvField(value: string | number): string {
  let str = String(value);
  if (FORMULA_PREFIX_PATTERN.test(str)) {
    str = `'${str}`;
  }
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function csvRow(fields: readonly (string | number)[]): string {
  return fields.map(csvField).join(',');
}

export function toCsv(transcript: Transcript): string {
  const lines = [csvRow(['certType', 'status', 'expiryDate'])];
  for (const cert of transcript.certifications) {
    lines.push(csvRow([cert.certType, cert.status, cert.expiryDate]));
  }
  lines.push('', csvRow(['category', 'hours']));
  for (const [category, hours] of Object.entries(transcript.hoursByCategory)) {
    lines.push(csvRow([category, hours]));
  }
  return lines.join('\n');
}

export function TranscriptScreen() {
  const theme = useTheme();
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

  const hours = transcript ? Object.entries(transcript.hoursByCategory) : [];

  return (
    <Screen>
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

      {transcript ? (
        <Button
          label="Share transcript (CSV)"
          variant="secondary"
          fullWidth
          onPress={() => void Share.share({ message: toCsv(transcript) })}
        />
      ) : null}

      {!hasHistory ? (
        <Card>
          <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>
            No training history on file.
          </Text>
        </Card>
      ) : (
        <>
          {transcript && transcript.certifications.length > 0 ? (
            <Card title="Certifications">
              <Rows>
                {transcript.certifications.map((cert) => (
                  <InfoRow
                    key={cert.certId}
                    title={cert.certType}
                    accessibilityLabel={`${cert.certType}, ${certificationStatusLabel(cert.status)}`}
                    trailing={<CertificationChip status={cert.status} />}
                  />
                ))}
              </Rows>
            </Card>
          ) : null}
          {hours.length > 0 ? (
            <Card title="Training hours">
              <Rows>
                {hours.map(([category, value]) => (
                  <InfoRow
                    key={category}
                    title={category}
                    accessibilityLabel={`${category}, ${value} ${value === 1 ? 'hour' : 'hours'}`}
                    trailing={
                      <Text
                        style={{ color: theme.fg, fontSize: ROW_TITLE_SIZE, fontWeight: '600' }}
                      >
                        {value} h
                      </Text>
                    }
                  />
                ))}
              </Rows>
            </Card>
          ) : null}
        </>
      )}
    </Screen>
  );
}
