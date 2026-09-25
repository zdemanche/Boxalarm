export const REPORT_NAMES = [
  'dashboard',
  'losap',
  'iso',
  'grants',
  'response-times',
  'membership-trends',
] as const;

export type ReportName = (typeof REPORT_NAMES)[number];
export type ExportFormat = 'csv' | 'pdf';

export interface TabularReport {
  readonly title: string;
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export function isReportName(value: string): value is ReportName {
  return (REPORT_NAMES as readonly string[]).includes(value);
}

export function isExportFormat(value: string): value is ExportFormat {
  return value === 'csv' || value === 'pdf';
}

export interface ExportJob {
  readonly jobId: string;
  readonly report: ReportName;
  readonly format: ExportFormat;
  readonly params: Readonly<Record<string, string>>;
  readonly status: 'PENDING' | 'COMPLETED' | 'FAILED';
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly detail?: string;
  readonly objectKey?: string;
}

function cell(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function renderCsv(report: TabularReport): string {
  const lines = [report.headers.map(cell).join(',')];
  for (const row of report.rows) {
    lines.push(row.map(cell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function pdfEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

export function renderPdf(report: TabularReport): Buffer {
  const lines = [
    report.title,
    report.headers.join(' | '),
    ...report.rows.map((row) => row.join(' | ')),
  ];
  const body = lines.map((line) => `(${pdfEscape(line)}) Tj T*`).join('\n');
  const contentStream = `BT\n/F1 10 Tf\n12 TL\n50 780 Td\n${body}\nET`;
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
