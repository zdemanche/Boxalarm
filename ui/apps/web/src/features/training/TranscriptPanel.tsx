import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { Badge, Button, Card, Skeleton } from '../../components/ui';
import { Download } from '../../components/ui/icons';
import { downloadTranscript, getTranscript } from './api';
import type { TranscriptExportFormat } from './types';
import { formatCalendarDate, toCalendarDate } from '../../lib/dates';
import { humanize } from '../../lib/labels';
import styles from './training.module.css';

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function TranscriptPanel({ memberId }: { memberId: string }) {
  const auth = useAuth();

  const transcriptQuery = useQuery({
    queryKey: ['training', 'transcript', memberId],
    queryFn: () => getTranscript(auth, memberId),
  });

  const [exportError, setExportError] = useState<string | null>(null);

  const onExport = async (format: TranscriptExportFormat) => {
    setExportError(null);
    try {
      const blob = await downloadTranscript(auth, memberId, format);
      triggerDownload(blob, `transcript-${memberId}.${format}`);
    } catch {
      setExportError(`The ${format.toUpperCase()} export failed. Try again.`);
    }
  };

  if (transcriptQuery.error) {
    return (
      <ApiForbiddenGate error={transcriptQuery.error} embedded>
        <p>Unexpected error</p>
      </ApiForbiddenGate>
    );
  }

  if (transcriptQuery.isLoading || !transcriptQuery.data) {
    return (
      <Card title="Transcript">
        <Skeleton lines={4} />
      </Card>
    );
  }

  const transcript = transcriptQuery.data;
  const hasHistory = transcript.certifications.length > 0 || transcript.attendance.length > 0;

  return (
    <Card title="Transcript">
      {!hasHistory ? (
        <p className={styles.muted}>No training history on file.</p>
      ) : (
        <>
          <section className={styles.section}>
            <h3 className={styles.subhead}>Certifications</h3>
            <ul className={styles.list}>
              {transcript.certifications.map((cert) => (
                <li key={cert.certId} className={styles.textRow}>
                  <span className={styles.rowTitle}>{cert.certType}</span>
                  <span className={styles.rowMeta}>
                    {' '}
                    — {humanize(cert.status)} · expires {formatCalendarDate(cert.expiryDate)}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className={styles.section}>
            <h3 className={styles.subhead}>Attendance</h3>
            <ul className={styles.list}>
              {transcript.attendance.map((record) => (
                <li key={`${record.eventId}-${record.startAt}`} className={styles.textRow}>
                  <span className={styles.rowTitle}>{record.category}</span>
                  <span className={styles.rowMeta}>
                    {' '}
                    — {record.hours}h on {formatCalendarDate(toCalendarDate(record.startAt))}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className={styles.section}>
            <h3 className={styles.subhead}>Hours by category</h3>
            <ul className={styles.pills}>
              {Object.entries(transcript.hoursByCategory).map(([category, hours]) => (
                <li key={category}>
                  <Badge>
                    {category}: {hours}h
                  </Badge>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      <div className={styles.formActions}>
        {exportError ? (
          <p role="alert" className={styles.error}>
            {exportError}
          </p>
        ) : null}
        <Button type="button" variant="secondary" onClick={() => void onExport('csv')}>
          <Download size={16} aria-hidden="true" />
          Export CSV
        </Button>
        <Button type="button" variant="secondary" onClick={() => void onExport('pdf')}>
          <Download size={16} aria-hidden="true" />
          Export PDF
        </Button>
      </div>
    </Card>
  );
}
