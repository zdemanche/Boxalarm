import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import type { ActivityType } from '../attendance/handler.js';

export class LosapRepositoryUnavailableError extends Error {
  readonly reason: string;

  constructor(cause: unknown) {
    super('The LOSAP data store is temporarily unavailable');
    this.name = 'LosapRepositoryUnavailableError';
    this.cause = cause;
    this.reason = cause instanceof Error ? cause.constructor.name : 'UnknownError';
  }
}

export function logLosapError(
  event: string,
  error: unknown,
  fields: Record<string, unknown> = {},
): void {
  console.error(
    JSON.stringify({
      event,
      service: 'personnel-service',
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      errorMessage: error instanceof Error ? error.message : String(error),
      ...fields,
    }),
  );
}

export interface LosapEntryInput {
  readonly deptId: VerifiedDeptId;
  readonly memberId: string;
  readonly year: number;
  readonly activityType: ActivityType;
  readonly points: number;
  readonly sourceRefId: string;
  readonly ruleVersionId: string;
  readonly entryId: string;
}

export function buildLosapEntryItem(input: LosapEntryInput): Record<string, unknown> {
  return {
    pk: buildDeptScopedPk(input.deptId, 'MEMBER', input.memberId),
    sk: `LOSAP#${input.year}#${input.entryId}`,
    entityType: 'LOSAP_POINT_ENTRY',
    year: input.year,
    activityType: input.activityType,
    points: input.points,
    sourceRefId: input.sourceRefId,
    ruleVersionId: input.ruleVersionId,
    gsi1pk: `MEMBER#${input.memberId}`,
    gsi1sk: `LOSAP_POINT_ENTRY#${input.year}`,
  };
}

async function queryMemberLosapPoints(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  memberId: string,
  year: number,
): Promise<readonly number[]> {
  const points: number[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': buildDeptScopedPk(deptId, 'MEMBER', memberId),
          ':skPrefix': `LOSAP#${year}#`,
        },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    points.push(...(result.Items ?? []).map((item) => item.points as number));
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);

  return points;
}

export async function getMemberLosapTotal(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  memberId: string,
  year: number,
): Promise<number> {
  try {
    const points = await queryMemberLosapPoints(client, tableName, deptId, memberId, year);
    return points.reduce((sum, entry) => sum + entry, 0);
  } catch (error) {
    logLosapError('losap.repository.getMemberLosapTotal.failed', error, {
      deptId,
      memberId,
      year,
    });
    throw new LosapRepositoryUnavailableError(error);
  }
}

export interface YearEndMemberTotal {
  readonly memberId: string;
  readonly totalPoints: number;
}

const YEAR_END_REPORT_CHUNK_SIZE = 25;

export async function getYearEndReport(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  memberIds: readonly string[],
  year: number,
): Promise<readonly YearEndMemberTotal[]> {
  try {
    const report: YearEndMemberTotal[] = [];
    for (let start = 0; start < memberIds.length; start += YEAR_END_REPORT_CHUNK_SIZE) {
      const chunk = memberIds.slice(start, start + YEAR_END_REPORT_CHUNK_SIZE);
      const chunkResults = await Promise.all(
        chunk.map(async (memberId) => {
          const points = await queryMemberLosapPoints(client, tableName, deptId, memberId, year);
          return { memberId, totalPoints: points.reduce((sum, entry) => sum + entry, 0) };
        }),
      );
      report.push(...chunkResults);
    }
    return report;
  } catch (error) {
    logLosapError('losap.repository.getYearEndReport.failed', error, { deptId, year });
    throw new LosapRepositoryUnavailableError(error);
  }
}
