import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { VerifiedDeptId } from '@boxalarm/dept-scope';
import { createDynamoClient, readGrantsReportConfig } from '../client.js';
import {
  createDynamoClient as createMembershipClient,
  readAttendanceTableConfig,
  readPersonnelTableConfig,
} from '../dynamoClient.js';
import { assembleGrantsReport } from '../grants/assembleReport.js';
import {
  getActiveMemberCountAndTrend,
  getApparatusOosHistory,
  getTrainingHoursCompliance,
} from '../grants/repository.js';
import { loadIsoReport } from '../iso/repository.js';
import { fetchAttendanceRecords, fetchMemberTimelines } from '../lib/memberTimeline.js';
import { computeMembershipTrend } from '../lib/membershipTrend.js';
import { buildYearEndReport } from '../losap/repository.js';
import { readIncidentTableName } from '../responseTimes/handler.js';
import { loadResponseTimeAnalytics } from '../responseTimes/repository.js';
import { loadDashboard } from '../dashboard/repository.js';
import type { ReportName, TabularReport } from './render.js';

function requireParam(params: Readonly<Record<string, string>>, key: string): string {
  const value = params[key];
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function requireNumber(params: Readonly<Record<string, string>>, key: string): number {
  const value = Number(requireParam(params, key));
  if (!Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number`);
  }
  return value;
}

function rowsFromObject(prefix: string, value: unknown, rows: string[][]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rowsFromObject(`${prefix}[${index}]`, entry, rows));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      rowsFromObject(prefix.length === 0 ? key : `${prefix}.${key}`, child, rows);
    }
    return;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    rows.push([prefix, String(value)]);
    return;
  }
  rows.push([prefix, '']);
}

export function tabularFromJson(title: string, value: unknown): TabularReport {
  const rows: string[][] = [];
  rowsFromObject('', value, rows);
  return { title, headers: ['field', 'value'], rows };
}

export async function buildExportTable(
  report: ReportName,
  params: Readonly<Record<string, string>>,
  deptId: VerifiedDeptId,
  platform: DynamoDBDocumentClient,
  platformTable: string,
): Promise<TabularReport> {
  switch (report) {
    case 'dashboard': {
      const view = await loadDashboard(platform, platformTable, deptId, Date.now());
      return tabularFromJson('Chief operational dashboard', view);
    }
    case 'losap': {
      const year = requireNumber(params, 'year');
      const yearEnd = await buildYearEndReport(platform, platformTable, deptId, year, 'export');
      return tabularFromJson(`LOSAP year-end ${year}`, yearEnd);
    }
    case 'iso': {
      const from = requireNumber(params, 'from');
      const to = requireNumber(params, 'to');
      const iso = await loadIsoReport(
        platform,
        platform,
        platformTable,
        readIncidentTableName(process.env),
        deptId,
        from,
        to,
      );
      return tabularFromJson('ISO report', iso);
    }
    case 'grants': {
      const periodStart = requireNumber(params, 'periodStart');
      const periodEnd = requireNumber(params, 'periodEnd');
      const client = createDynamoClient(process.env, platform);
      const config = readGrantsReportConfig(process.env);
      const period = { periodStart, periodEnd };
      const [memberCountAndTrend, trainingHoursCompliance, apparatusOosHistory] = await Promise.all(
        [
          getActiveMemberCountAndTrend(client, config, deptId, period, 'export'),
          getTrainingHoursCompliance(client, config, deptId, period, 'export'),
          getApparatusOosHistory(client, config, deptId, period, 'export'),
        ],
      );
      return tabularFromJson(
        'Grant support report',
        assembleGrantsReport({
          period,
          memberCountAndTrend,
          trainingHoursCompliance,
          apparatusOosHistory,
          incidentVolume: { available: false, reason: 'E6-S1' },
        }),
      );
    }
    case 'response-times': {
      const from = requireNumber(params, 'from');
      const to = requireNumber(params, 'to');
      const analytics = await loadResponseTimeAnalytics(
        platform,
        readIncidentTableName(process.env),
        deptId,
        from,
        to,
      );
      return tabularFromJson('Response-time analytics', { from, to, ...analytics });
    }
    case 'membership-trends': {
      const startDate = requireParam(params, 'startDate');
      const endDate = requireParam(params, 'endDate');
      const startMs = Date.parse(startDate);
      const endMs = Date.parse(endDate);
      if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
        throw new Error('startDate and endDate must be ISO dates');
      }
      const membershipClient = createMembershipClient(process.env, platform);
      const { tableName: personnelTable } = readPersonnelTableConfig(process.env);
      const { tableName: attendanceTable } = readAttendanceTableConfig(process.env);
      const timelines = await fetchMemberTimelines(membershipClient, personnelTable, deptId);
      const attendance = await fetchAttendanceRecords(
        membershipClient,
        attendanceTable,
        timelines.map((timeline) => timeline.memberId),
        startMs,
        endMs,
      );
      return tabularFromJson(
        'Membership trends',
        computeMembershipTrend(timelines, attendance, startMs, endMs),
      );
    }
    default: {
      const exhaustive: never = report;
      return exhaustive;
    }
  }
}
