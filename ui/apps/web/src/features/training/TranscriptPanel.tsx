import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { downloadTranscript, getTranscript } from './api';
import type { TranscriptExportFormat } from './types';

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

  const onExport = async (format: TranscriptExportFormat) => {
    const blob = await downloadTranscript(auth, memberId, format);
    triggerDownload(blob, `transcript-${memberId}.${format}`);
  };

  if (transcriptQuery.error) {
    return (
      <ApiForbiddenGate error={transcriptQuery.error} embedded>
        <p>Unexpected error</p>
      </ApiForbiddenGate>
    );
  }

  if (transcriptQuery.isLoading || !transcriptQuery.data) {
    return <p>Loading transcript…</p>;
  }

  const transcript = transcriptQuery.data;
  const hasHistory = transcript.certifications.length > 0 || transcript.attendance.length > 0;

  return (
    <section aria-label="Training transcript" style={{ marginTop: 'var(--boxalarm-spacing-lg)' }}>
      <h2 style={{ fontSize: 'var(--boxalarm-font-size-lg)', margin: 0 }}>Transcript</h2>
      <div style={{ display: 'flex', gap: 'var(--boxalarm-spacing-sm)', marginTop: 8 }}>
        <button type="button" onClick={() => void onExport('csv')} style={{ minHeight: 44 }}>
          Export CSV
        </button>
        <button type="button" onClick={() => void onExport('pdf')} style={{ minHeight: 44 }}>
          Export PDF
        </button>
      </div>

      {!hasHistory ? (
        <p>No training history on file.</p>
      ) : (
        <>
          <h3 style={{ fontSize: 'var(--boxalarm-font-size-base)' }}>Certifications</h3>
          <ul>
            {transcript.certifications.map((cert) => (
              <li key={cert.certId}>
                {cert.certType} — {cert.status} · expires {cert.expiryDate}
              </li>
            ))}
          </ul>

          <h3 style={{ fontSize: 'var(--boxalarm-font-size-base)' }}>Attendance</h3>
          <ul>
            {transcript.attendance.map((record) => (
              <li key={`${record.eventId}-${record.startAt}`}>
                {record.category} — {record.hours}h on{' '}
                {new Date(record.startAt).toLocaleDateString()}
              </li>
            ))}
          </ul>

          <h3 style={{ fontSize: 'var(--boxalarm-font-size-base)' }}>Hours by category</h3>
          <ul>
            {Object.entries(transcript.hoursByCategory).map(([category, hours]) => (
              <li key={category}>
                {category}: {hours}h
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
