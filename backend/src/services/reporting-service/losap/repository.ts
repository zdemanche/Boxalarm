import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

const LOSAP_ELIGIBLE_STATUSES = new Set(['ACTIVE', 'RETIRED']);

export interface RosterMember {
  readonly memberId: string;
  readonly status: string;
}

export interface LosapMemberTotal {
  readonly memberId: string;
  readonly totalPoints: number;
  readonly entryCount: number;
}

export interface LosapYearEndReport {
  readonly deptId: string;
  readonly year: number;
  readonly members: readonly LosapMemberTotal[];
  readonly hasData: boolean;
}

function logRepositoryError(event: string, error: unknown, context: Record<string, unknown>): void {
  console.error(
    JSON.stringify({
      event,
      service: 'reporting-service',
      ...context,
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      message: error instanceof Error ? error.message : undefined,
    }),
  );
}

export async function listLosapEligibleMembers(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
): Promise<readonly RosterMember[]> {
  const members: RosterMember[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  try {
    do {
      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: 'GSI3',
          KeyConditionExpression: 'gsi3pk = :gsi3pk',
          ExpressionAttributeValues: { ':gsi3pk': buildDeptScopedPk(deptId, 'MEMBER') },
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }),
      );
      members.push(
        ...(result.Items ?? []).map((item) => ({
          memberId: item.memberId as string,
          status: item.status as string,
        })),
      );
      exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (exclusiveStartKey);
  } catch (error) {
    logRepositoryError('reporting.losap.roster.failed', error, { deptId });
    throw error;
  }
  return members.filter((member) => LOSAP_ELIGIBLE_STATUSES.has(member.status));
}

export async function sumLosapPointsForMemberYear(
  client: DynamoDBDocumentClient,
  tableName: string,
  memberId: string,
  year: number,
): Promise<{ totalPoints: number; entryCount: number }> {
  let totalPoints = 0;
  let entryCount = 0;
  let exclusiveStartKey: Record<string, unknown> | undefined;
  try {
    do {
      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: 'GSI1',
          KeyConditionExpression: 'gsi1pk = :gsi1pk AND begins_with(gsi1sk, :prefix)',
          ExpressionAttributeValues: {
            ':gsi1pk': `MEMBER#${memberId}`,
            ':prefix': `LOSAP_POINT_ENTRY#${year}`,
          },
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }),
      );
      for (const item of result.Items ?? []) {
        const points: unknown = item.points;
        if (typeof points === 'number' && Number.isFinite(points)) {
          totalPoints += points;
        } else {
          console.error(
            JSON.stringify({
              event: 'reporting.losap.entry.non_numeric_points',
              service: 'reporting-service',
              memberId,
              year,
            }),
          );
        }
        entryCount += 1;
      }
      exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (exclusiveStartKey);
  } catch (error) {
    logRepositoryError('reporting.losap.entries.failed', error, { memberId, year });
    throw error;
  }
  return { totalPoints, entryCount };
}

export async function buildYearEndReport(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  year: number,
): Promise<LosapYearEndReport> {
  const roster = await listLosapEligibleMembers(client, tableName, deptId);
  const members = await Promise.all(
    roster.map(async (member) => {
      const { totalPoints, entryCount } = await sumLosapPointsForMemberYear(
        client,
        tableName,
        member.memberId,
        year,
      );
      return { memberId: member.memberId, totalPoints, entryCount };
    }),
  );
  const hasData = members.some((member) => member.entryCount > 0);
  return { deptId, year, members, hasData };
}
