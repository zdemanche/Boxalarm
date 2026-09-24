import type { CertificationStatus } from '../me/certificationStatus';

export interface Certification {
  certId: string;
  certType: string;
  issuingAuthority: string;
  expiryDate: string;
  status: CertificationStatus;
}

export interface TrainingEvent {
  eventId: string;
  title: string;
  category: string;
  startAt: number;
  endAt: number;
  signedUp: boolean;
}

export interface TranscriptAttendance {
  eventId: string;
  category: string;
  hours: number;
  startAt: number;
}

export interface Transcript {
  memberId: string;
  certifications: readonly Certification[];
  attendance: readonly TranscriptAttendance[];
  hoursByCategory: Readonly<Record<string, number>>;
}

export interface NotificationItem {
  notificationId: string;
  category: string;
  summary: string;
  createdAt: number;
  readAt: number | null;
}

export interface NotificationChannelMutes {
  push: boolean;
  email: boolean;
}

export interface NotificationPreference {
  category: string;
  channels: NotificationChannelMutes;
}
