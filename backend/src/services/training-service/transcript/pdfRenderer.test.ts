import { describe, expect, it } from 'vitest';
import type { CertificationRecord } from '../certificationRepository.js';
import { renderTranscriptPdf } from './pdfRenderer.js';
import { buildTranscript } from './transcript.js';

const CERT: CertificationRecord = {
  certId: 'CERT-0001',
  memberId: 'MBR-0034',
  certType: 'FF1',
  issueDate: '2020-01-10',
  expiryDate: '2099-01-10',
  issuingAuthority: 'CT DESPP',
  attachmentS3Key: null,
  status: 'CURRENT',
};

describe('renderTranscriptPdf', () => {
  it('produces a valid minimal PDF with member and certification content in the stream (AC2)', () => {
    const transcript = buildTranscript(
      'MBR-0034',
      [CERT],
      [{ eventId: 'e1', category: 'LADDER_OPS', hours: 3, startAt: 100 }],
    );

    const pdf = renderTranscriptPdf(transcript);
    const text = pdf.toString('latin1');

    expect(text.startsWith('%PDF-1.')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('MBR-0034');
    expect(text).toContain('CERT-0001');
    expect(text).toContain('LADDER_OPS');
  });

  it('renders a well-formed PDF for an empty transcript without error (AC3)', () => {
    const pdf = renderTranscriptPdf(buildTranscript('MBR-9999', [], []));
    const text = pdf.toString('latin1');

    expect(text.startsWith('%PDF-1.')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('\\(none\\)');
  });
});
