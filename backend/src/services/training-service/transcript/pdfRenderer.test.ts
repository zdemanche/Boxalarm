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

  it('paginates a long history so no line falls below the page and every page is indexed', () => {
    const attendance = Array.from({ length: 150 }, (_, i) => ({
      eventId: `event-${i}`,
      category: 'LADDER_OPS',
      hours: 1,
      startAt: i,
    }));
    const text = renderTranscriptPdf(buildTranscript('MBR-0034', [CERT], attendance)).toString(
      'latin1',
    );

    const pageCount = (text.match(/\/Type \/Page /g) ?? []).length;
    expect(pageCount).toBeGreaterThan(1);
    expect(text).toContain(`/Count ${pageCount}`);
    expect(text).toContain('event-149');
    expect(text).toContain('LADDER_OPS: 150h');
    for (const stream of text.match(/stream\n[\s\S]*?\nendstream/g) ?? []) {
      expect((stream.match(/ Tj/g) ?? []).length).toBeLessThanOrEqual(60);
    }
    const xrefStart = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(xrefStart, xrefStart + 4)).toBe('xref');
    const offsets = [...text.matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]));
    offsets.forEach((offset, i) => {
      expect(text.slice(offset).startsWith(`${i + 1} 0 obj`)).toBe(true);
    });
  });

  it('renders a well-formed PDF for an empty transcript without error (AC3)', () => {
    const pdf = renderTranscriptPdf(buildTranscript('MBR-9999', [], []));
    const text = pdf.toString('latin1');

    expect(text.startsWith('%PDF-1.')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('\\(none\\)');
  });
});
