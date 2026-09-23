import type { AttendanceRecord } from '../repository.js';

const UNCATEGORIZED = 'UNCATEGORIZED';

export interface IsoReportMemberTotal {
  readonly memberId: string;
  readonly hours: number;
}

export interface IsoReportCategory {
  readonly category: string;
  readonly totalHours: number;
  readonly members: readonly IsoReportMemberTotal[];
}

export interface IsoTrainingReport {
  readonly period: number;
  readonly departmentTotalHours: number;
  readonly categories: readonly IsoReportCategory[];
}

export function mapToIsoCategory(rawCategory: string): string {
  const normalized = rawCategory.trim().toUpperCase();
  return normalized.length > 0 ? normalized : UNCATEGORIZED;
}

export function buildIsoReport(
  records: readonly AttendanceRecord[],
  period: number,
): IsoTrainingReport {
  const memberHoursByCategory = new Map<string, Map<string, number>>();

  for (const record of records) {
    const category = mapToIsoCategory(record.category);
    const memberHours = memberHoursByCategory.get(category) ?? new Map<string, number>();
    memberHours.set(record.memberId, (memberHours.get(record.memberId) ?? 0) + record.hours);
    memberHoursByCategory.set(category, memberHours);
  }

  const categories: IsoReportCategory[] = [...memberHoursByCategory.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, memberHours]) => {
      const members = [...memberHours.entries()]
        .map(([memberId, hours]) => ({ memberId, hours }))
        .sort((a, b) => a.memberId.localeCompare(b.memberId));
      return {
        category,
        totalHours: members.reduce((sum, member) => sum + member.hours, 0),
        members,
      };
    });

  return {
    period,
    departmentTotalHours: categories.reduce((sum, category) => sum + category.totalHours, 0),
    categories,
  };
}
