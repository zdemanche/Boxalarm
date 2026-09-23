import type { Transcript } from './transcript.js';

function pdfEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function buildTranscriptLines(transcript: Transcript): readonly string[] {
  const lines: string[] = [`Training Transcript - Member ${transcript.memberId}`, ''];

  lines.push('Certifications:');
  if (transcript.certifications.length === 0) {
    lines.push('  (none)');
  }
  for (const cert of transcript.certifications) {
    lines.push(`  ${cert.certType} (${cert.certId}) - ${cert.status} - expires ${cert.expiryDate}`);
  }
  lines.push('');

  lines.push('Attendance:');
  if (transcript.attendance.length === 0) {
    lines.push('  (none)');
  }
  for (const record of transcript.attendance) {
    lines.push(`  ${record.category} - ${record.hours}h - event ${record.eventId}`);
  }
  lines.push('');

  lines.push('Hours By Category:');
  const categories = Object.entries(transcript.hoursByCategory);
  if (categories.length === 0) {
    lines.push('  (none)');
  }
  for (const [category, hours] of categories) {
    lines.push(`  ${category}: ${hours}h`);
  }

  return lines;
}

function buildContentStream(lines: readonly string[]): string {
  const body = lines.map((line) => `(${pdfEscape(line)}) Tj T*`).join('\n');
  return `BT\n/F1 10 Tf\n12 TL\n50 780 Td\n${body}\nET`;
}

export function renderTranscriptPdf(transcript: Transcript): Buffer {
  const contentStream = buildContentStream(buildTranscriptLines(transcript));
  const contentLength = Buffer.byteLength(contentStream, 'latin1');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${contentLength} >>\nstream\n${contentStream}\nendstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  objects.forEach((obj, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${obj}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return Buffer.from(pdf, 'latin1');
}
