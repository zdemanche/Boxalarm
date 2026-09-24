import type { AttendanceRecord, AttendanceRepository } from './types';

let records: AttendanceRecord[] = [
  { activityType: 'DRILL', refId: null, occurredAt: 1758000000, hours: 2 },
];

export const mockAttendanceRepository: AttendanceRepository = {
  async getOwnRecords() {
    return records;
  },
  async record(entry) {
    records = [...records, entry];
  },
};
