import type { CertificationRecord } from '../certificationRepository.js';
import type { MemberAttendanceRecord } from '../repository.js';

export interface Transcript {
  readonly memberId: string;
  readonly certifications: readonly CertificationRecord[];
  readonly attendance: readonly MemberAttendanceRecord[];
  readonly hoursByCategory: Readonly<Record<string, number>>;
}

export function buildTranscript(
  memberId: string,
  certifications: readonly CertificationRecord[],
  attendance: readonly MemberAttendanceRecord[],
): Transcript {
  const hoursByCategory: Record<string, number> = {};
  for (const record of attendance) {
    hoursByCategory[record.category] = (hoursByCategory[record.category] ?? 0) + record.hours;
  }
  return { memberId, certifications, attendance, hoursByCategory };
}

function csvField(value: string | number): string {
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function csvRow(fields: readonly (string | number)[]): string {
  return fields.map(csvField).join(',');
}

export function toCsv(transcript: Transcript): string {
  const lines: string[] = [];

  lines.push(`Training Transcript,${transcript.memberId}`);
  lines.push('');

  lines.push('Certifications');
  lines.push(
    csvRow(['certId', 'certType', 'issueDate', 'expiryDate', 'issuingAuthority', 'status']),
  );
  for (const cert of transcript.certifications) {
    lines.push(
      csvRow([
        cert.certId,
        cert.certType,
        cert.issueDate,
        cert.expiryDate,
        cert.issuingAuthority,
        cert.status,
      ]),
    );
  }
  lines.push('');

  lines.push('Attendance');
  lines.push(csvRow(['eventId', 'category', 'hours', 'startAt']));
  for (const record of transcript.attendance) {
    lines.push(csvRow([record.eventId, record.category, record.hours, record.startAt]));
  }
  lines.push('');

  lines.push('Hours By Category');
  lines.push(csvRow(['category', 'hours']));
  for (const [category, hours] of Object.entries(transcript.hoursByCategory)) {
    lines.push(csvRow([category, hours]));
  }

  return lines.join('\n');
}
