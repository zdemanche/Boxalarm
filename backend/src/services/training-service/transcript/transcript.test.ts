import { describe, expect, it } from 'vitest';
import type { CertificationRecord } from '../certificationRepository.js';
import type { MemberAttendanceRecord } from '../repository.js';
import { buildTranscript, toCsv } from './transcript.js';

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

describe('buildTranscript', () => {
  it('sums hours per category across attendance records (AC1)', () => {
    const attendance: MemberAttendanceRecord[] = [
      { eventId: 'e1', category: 'LADDER_OPS', hours: 3, startAt: 100 },
      { eventId: 'e2', category: 'LADDER_OPS', hours: 2, startAt: 200 },
      { eventId: 'e3', category: 'EMS', hours: 4, startAt: 300 },
    ];

    const transcript = buildTranscript('MBR-0034', [CERT], attendance);

    expect(transcript.hoursByCategory).toEqual({ LADDER_OPS: 5, EMS: 4 });
    expect(transcript.certifications).toEqual([CERT]);
    expect(transcript.attendance).toEqual(attendance);
  });

  it('renders a well-formed, empty transcript for a member with no history (AC3)', () => {
    const transcript = buildTranscript('MBR-9999', [], []);

    expect(transcript).toEqual({
      memberId: 'MBR-9999',
      certifications: [],
      attendance: [],
      hoursByCategory: {},
    });
  });
});

describe('toCsv', () => {
  it('quotes and escapes fields containing commas, quotes, or newlines', () => {
    const transcript = buildTranscript(
      'MBR-0034',
      [{ ...CERT, issuingAuthority: 'CT DESPP, "State" Office' }],
      [],
    );

    const csv = toCsv(transcript);

    expect(csv).toContain('"CT DESPP, ""State"" Office"');
  });

  it('renders every section for an empty transcript without error (AC3)', () => {
    const csv = toCsv(buildTranscript('MBR-9999', [], []));

    expect(csv).toContain('Certifications');
    expect(csv).toContain('Attendance');
    expect(csv).toContain('Hours By Category');
    expect(csv).toContain('MBR-9999');
  });

  it('includes certification, attendance, and category-total content (AC2)', () => {
    const csv = toCsv(
      buildTranscript(
        'MBR-0034',
        [CERT],
        [{ eventId: 'e1', category: 'LADDER_OPS', hours: 3, startAt: 100 }],
      ),
    );

    expect(csv).toContain('CERT-0001');
    expect(csv).toContain('LADDER_OPS');
    expect(csv).toContain('3');
  });
});
