import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import type { GrantsReportConfig } from '../client.js';
import { logError } from '../logger.js';

const FANOUT_CONCURRENCY = 5;

export interface ReportPeriod {
  readonly periodStart: number;
  readonly periodEnd: number;
}

export interface MemberCountAndTrend {
  readonly activeMemberCount: number;
  readonly joinedInPeriod: number;
}

export interface TrainingHoursCompliance {
  readonly totalHours: number;
  readonly memberCount: number;
  readonly eventCount: number;
}

export interface ApparatusOosRecord {
  readonly unitId: string;
  readonly reason: string;
  readonly startAt: number;
  readonly endAt: number | null;
}

export interface ApparatusOosHistory {
  readonly records: readonly ApparatusOosRecord[];
  readonly totalOutOfServiceEvents: number;
}

async function queryAllPages(
  client: DynamoDBDocumentClient,
  buildCommand: (exclusiveStartKey?: Record<string, unknown>) => QueryCommand,
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const output = await client.send(buildCommand(exclusiveStartKey));
    items.push(...(output.Items ?? []));
    exclusiveStartKey = output.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return items;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length) as R[];
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await fn(items[current] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function isWithinPeriod(timestampMs: number, period: ReportPeriod): boolean {
  return timestampMs >= period.periodStart && timestampMs < period.periodEnd;
}

function overlapsPeriod(startAtMs: number, endAtMs: number | null, period: ReportPeriod): boolean {
  return startAtMs < period.periodEnd && (endAtMs === null || endAtMs >= period.periodStart);
}

export async function getActiveMemberCountAndTrend(
  client: DynamoDBDocumentClient,
  config: GrantsReportConfig,
  deptId: VerifiedDeptId,
  period: ReportPeriod,
  traceId?: string,
): Promise<MemberCountAndTrend> {
  try {
    const items = await queryAllPages(
      client,
      (exclusiveStartKey) =>
        new QueryCommand({
          TableName: config.personnelTableName,
          IndexName: 'GSI3',
          KeyConditionExpression: 'gsi3pk = :gsi3pk',
          ExpressionAttributeValues: { ':gsi3pk': buildDeptScopedPk(deptId, 'MEMBER') },
          ExclusiveStartKey: exclusiveStartKey,
        }),
    );
    let activeMemberCount = 0;
    let joinedInPeriod = 0;
    for (const item of items) {
      if (item.status === 'ACTIVE') {
        activeMemberCount += 1;
      }
      const joinDateMs = typeof item.joinDate === 'string' ? Date.parse(item.joinDate) : NaN;
      if (Number.isFinite(joinDateMs) && isWithinPeriod(joinDateMs, period)) {
        joinedInPeriod += 1;
      }
    }
    return { activeMemberCount, joinedInPeriod };
  } catch (error) {
    logError('reporting.grants.memberCount.failed', error, { deptId, correlationId: traceId });
    throw error;
  }
}

export async function getTrainingHoursCompliance(
  client: DynamoDBDocumentClient,
  config: GrantsReportConfig,
  deptId: VerifiedDeptId,
  period: ReportPeriod,
  traceId?: string,
): Promise<TrainingHoursCompliance> {
  try {
    const eventItems = await queryAllPages(
      client,
      (exclusiveStartKey) =>
        new QueryCommand({
          TableName: config.trainingTableName,
          IndexName: 'GSI3',
          KeyConditionExpression: 'gsi3pk = :gsi3pk',
          ExpressionAttributeValues: { ':gsi3pk': buildDeptScopedPk(deptId, 'TRAINING_EVENT') },
          ExclusiveStartKey: exclusiveStartKey,
        }),
    );
    const eventsInPeriod = eventItems.filter((item) => {
      const startAtSeconds = typeof item.startAt === 'number' ? item.startAt : NaN;
      return Number.isFinite(startAtSeconds) && isWithinPeriod(startAtSeconds * 1000, period);
    });

    const attendeeLists = await mapWithConcurrency(eventsInPeriod, FANOUT_CONCURRENCY, (event) =>
      queryAllPages(
        client,
        (exclusiveStartKey) =>
          new QueryCommand({
            TableName: config.trainingTableName,
            KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
            ExpressionAttributeValues: {
              ':pk': buildDeptScopedPk(deptId, 'TRAINING_EVENT', event.eventId as string),
              ':prefix': 'ATTENDEE#',
            },
            ExclusiveStartKey: exclusiveStartKey,
          }),
      ),
    );

    const members = new Set<string>();
    let totalHours = 0;
    for (const attendees of attendeeLists) {
      for (const attendee of attendees) {
        const hours =
          typeof attendee.hours === 'number' &&
          Number.isFinite(attendee.hours) &&
          attendee.hours >= 0
            ? attendee.hours
            : 0;
        totalHours += hours;
        if (typeof attendee.memberId === 'string') {
          members.add(attendee.memberId);
        }
      }
    }

    return { totalHours, memberCount: members.size, eventCount: eventsInPeriod.length };
  } catch (error) {
    logError('reporting.grants.trainingHours.failed', error, { deptId, correlationId: traceId });
    throw error;
  }
}

export async function getApparatusOosHistory(
  client: DynamoDBDocumentClient,
  config: GrantsReportConfig,
  deptId: VerifiedDeptId,
  period: ReportPeriod,
  traceId?: string,
): Promise<ApparatusOosHistory> {
  try {
    const apparatusItems = await queryAllPages(
      client,
      (exclusiveStartKey) =>
        new QueryCommand({
          TableName: config.platformTableName,
          IndexName: 'GSI3',
          KeyConditionExpression: 'gsi3pk = :gsi3pk',
          ExpressionAttributeValues: { ':gsi3pk': buildDeptScopedPk(deptId, 'APPARATUS') },
          ExclusiveStartKey: exclusiveStartKey,
        }),
    );

    const oosLists = await mapWithConcurrency(
      apparatusItems,
      FANOUT_CONCURRENCY,
      async (apparatus) => {
        const apparatusId = apparatus.apparatusId as string;
        const unitId = apparatus.unitId as string;
        const items = await queryAllPages(
          client,
          (exclusiveStartKey) =>
            new QueryCommand({
              TableName: config.platformTableName,
              KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
              ExpressionAttributeValues: {
                ':pk': buildDeptScopedPk(deptId, 'APPARATUS', apparatusId),
                ':prefix': 'OOS#',
              },
              ExclusiveStartKey: exclusiveStartKey,
            }),
        );
        return items
          .filter((item) => {
            const startAtSeconds = typeof item.startAt === 'number' ? item.startAt : NaN;
            if (!Number.isFinite(startAtSeconds)) {
              return false;
            }
            const endAtSeconds = typeof item.endAt === 'number' ? item.endAt : null;
            const endAtMs = endAtSeconds === null ? null : endAtSeconds * 1000;
            return overlapsPeriod(startAtSeconds * 1000, endAtMs, period);
          })
          .map((item): ApparatusOosRecord => ({
            unitId,
            reason: typeof item.reason === 'string' ? item.reason : 'unknown',
            startAt: item.startAt as number,
            endAt: typeof item.endAt === 'number' ? item.endAt : null,
          }));
      },
    );

    const records = oosLists.flat();
    return { records, totalOutOfServiceEvents: records.length };
  } catch (error) {
    logError('reporting.grants.apparatusOos.failed', error, { deptId, correlationId: traceId });
    throw error;
  }
}
