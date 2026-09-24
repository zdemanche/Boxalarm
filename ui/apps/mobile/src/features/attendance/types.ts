export type ActivityType = 'CALL' | 'DRILL' | 'MEETING' | 'WORK_DETAIL' | 'STANDBY';

export interface AttendanceRecord {
  activityType: ActivityType;
  refId: string | null;
  occurredAt: number;
  hours: number;
}

export interface AttendanceRepository {
  getOwnRecords(): Promise<AttendanceRecord[]>;
  record(entry: AttendanceRecord): Promise<void>;
}
