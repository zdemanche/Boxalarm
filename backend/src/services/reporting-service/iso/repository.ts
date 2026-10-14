import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { queryAllPages } from '../lib/queryAll.js';
import { logError } from '../logger.js';
import { loadResponseTimeAnalytics } from '../responseTimes/repository.js';
import type { ResponseTimeAnalytics } from '../responseTimes/compute.js';
import {
  EMPTY_APPARATUS,
  EMPTY_HYDRANTS,
  EMPTY_TRAINING,
  epochToIsoDate,
  summarizeApparatusTests,
  summarizeHydrants,
  summarizeTrainingHours,
  type ApparatusTestsSection,
  type HydrantFlowSection,
  type TrainingHoursSection,
} from './summarize.js';

const EPOCH_SORT_WIDTH = 13;
const HYDRANT_READ_CONCURRENCY = 25;

function padEpoch(value: number): string {
  return String(value).padStart(EPOCH_SORT_WIDTH, '0');
}

export interface IsoReport {
  readonly from: number;
  readonly to: number;
  readonly trainingHours: TrainingHoursSection;
  readonly apparatusTests: ApparatusTestsSection;
  readonly hydrantFlowTests: HydrantFlowSection;
  readonly responseTimes: ResponseTimeAnalytics;
}

async function loadTrainingHours(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  from: number,
  to: number,
): Promise<TrainingHoursSection> {
  const events = await queryAllPages(client, {
    TableName: tableName,
    IndexName: 'GSI3',
    KeyConditionExpression: 'gsi3pk = :pk AND gsi3sk BETWEEN :from AND :to',
    ExpressionAttributeValues: {
      ':pk': buildDeptScopedPk(deptId, 'TRAINING_EVENT'),
      ':from': padEpoch(Math.floor(from) * 1000),
      ':to': padEpoch(Math.floor(to) * 1000 + 999),
    },
  });
  const records: { category: string; hours: number }[] = [];
  for (const event of events) {
    const eventId = event.eventId;
    const category = typeof event.category === 'string' ? event.category : '';
    if (typeof eventId !== 'string') {
      continue;
    }
    const attendees = await queryAllPages(client, {
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': buildDeptScopedPk(deptId, 'TRAINING_EVENT', eventId),
        ':prefix': 'ATTENDEE#',
      },
    });
    for (const attendee of attendees) {
      const hours = typeof attendee.hours === 'number' && attendee.hours >= 0 ? attendee.hours : 0;
      records.push({ category, hours });
    }
  }
  return summarizeTrainingHours(records);
}

async function loadApparatusTests(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  fromDate: string,
  toDate: string,
): Promise<ApparatusTestsSection> {
  const apparatus = await queryAllPages(client, {
    TableName: tableName,
    IndexName: 'GSI3',
    KeyConditionExpression: 'gsi3pk = :pk',
    ExpressionAttributeValues: { ':pk': buildDeptScopedPk(deptId, 'APPARATUS') },
  });
  const records: { testType: string; result: string }[] = [];
  for (const unit of apparatus) {
    const apparatusId = unit.apparatusId;
    if (typeof apparatusId !== 'string') {
      continue;
    }
    const tests = await queryAllPages(client, {
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': buildDeptScopedPk(deptId, 'APPARATUS', apparatusId),
        ':prefix': 'TEST#',
      },
    });
    for (const test of tests) {
      const testDate = test.testDate;
      const testType = test.testType;
      const result = test.result;
      if (
        typeof testDate !== 'string' ||
        testDate < fromDate ||
        testDate > toDate ||
        typeof testType !== 'string' ||
        typeof result !== 'string'
      ) {
        continue;
      }
      records.push({ testType, result });
    }
  }
  return summarizeApparatusTests(records);
}

export async function loadHydrantFlowTests(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  to: number,
): Promise<HydrantFlowSection> {
  const listed = await queryAllPages(client, {
    TableName: tableName,
    IndexName: 'GSI3',
    KeyConditionExpression: 'gsi3pk = :pk',
    ExpressionAttributeValues: { ':pk': buildDeptScopedPk(deptId, 'HYDRANT') },
  });
  const hydrantIds = listed.flatMap((entry) =>
    typeof entry.hydrantId === 'string' ? [entry.hydrantId] : [],
  );
  const records: { hydrantId: string; nextFlowTestDue: string }[] = [];
  for (let start = 0; start < hydrantIds.length; start += HYDRANT_READ_CONCURRENCY) {
    const rows = await Promise.all(
      hydrantIds.slice(start, start + HYDRANT_READ_CONCURRENCY).map((hydrantId) =>
        queryAllPages(client, {
          TableName: tableName,
          KeyConditionExpression: 'pk = :pk AND sk = :sk',
          ExpressionAttributeValues: {
            ':pk': buildDeptScopedPk(deptId, 'HYDRANT', hydrantId),
            ':sk': 'METADATA',
          },
        }),
      ),
    );
    for (const item of rows.flat()) {
      if (
        item.archivedAt === undefined &&
        typeof item.hydrantId === 'string' &&
        typeof item.nextFlowTestDue === 'string'
      ) {
        records.push({ hydrantId: item.hydrantId, nextFlowTestDue: item.nextFlowTestDue });
      }
    }
  }
  return summarizeHydrants(records, epochToIsoDate(to));
}

const EMPTY_RESPONSE: ResponseTimeAnalytics = {
  units: [],
  turnout: { medianSeconds: null, p90Seconds: null, sampleCount: 0, excludedCount: 0 },
  travel: { medianSeconds: null, p90Seconds: null, sampleCount: 0, excludedCount: 0 },
  total: { medianSeconds: null, p90Seconds: null, sampleCount: 0, excludedCount: 0 },
};

async function sectionOrEmpty<T>(section: string, empty: T, load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error) {
    logError('reporting.iso.section_failed', error, { section });
    return empty;
  }
}

export async function loadIsoReport(
  platform: DynamoDBDocumentClient,
  incident: DynamoDBDocumentClient,
  platformTable: string,
  incidentTable: string,
  deptId: VerifiedDeptId,
  from: number,
  to: number,
): Promise<IsoReport> {
  const fromDate = epochToIsoDate(from);
  const toDate = epochToIsoDate(to);
  const [trainingHours, apparatusTests, hydrantFlowTests, responseTimes] = await Promise.all([
    sectionOrEmpty('trainingHours', EMPTY_TRAINING, () =>
      loadTrainingHours(platform, platformTable, deptId, from, to),
    ),
    sectionOrEmpty('apparatusTests', EMPTY_APPARATUS, () =>
      loadApparatusTests(platform, platformTable, deptId, fromDate, toDate),
    ),
    sectionOrEmpty('hydrantFlowTests', EMPTY_HYDRANTS, () =>
      loadHydrantFlowTests(platform, platformTable, deptId, to),
    ),
    sectionOrEmpty('responseTimes', EMPTY_RESPONSE, () =>
      loadResponseTimeAnalytics(incident, incidentTable, deptId, from, to),
    ),
  ]);
  return { from, to, trainingHours, apparatusTests, hydrantFlowTests, responseTimes };
}
