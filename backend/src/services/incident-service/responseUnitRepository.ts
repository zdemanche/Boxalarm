import { UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';

const TIME_FIELDS = ['dispatchedAt', 'enRouteAt', 'arrivedAt', 'clearedAt'] as const;
type TimeField = (typeof TIME_FIELDS)[number];

export interface ResponseUnitTimesInput {
  readonly deptId: VerifiedDeptId;
  readonly incidentId: string;
  readonly unitId: string;
  readonly unitType: 'APPARATUS' | 'MEMBER';
  readonly times: Partial<Record<TimeField, number>>;
}

export interface ResponseUnit {
  readonly incidentId: string;
  readonly unitId: string;
  readonly unitType: string;
  readonly dispatchedAt?: number;
  readonly enRouteAt?: number;
  readonly arrivedAt?: number;
  readonly clearedAt?: number;
}

function toResponseUnit(item: Record<string, unknown>): ResponseUnit {
  return {
    incidentId: item.incidentId as string,
    unitId: item.unitId as string,
    unitType: item.unitType as string,
    ...(typeof item.dispatchedAt === 'number' ? { dispatchedAt: item.dispatchedAt } : {}),
    ...(typeof item.enRouteAt === 'number' ? { enRouteAt: item.enRouteAt } : {}),
    ...(typeof item.arrivedAt === 'number' ? { arrivedAt: item.arrivedAt } : {}),
    ...(typeof item.clearedAt === 'number' ? { clearedAt: item.clearedAt } : {}),
  };
}

/**
 * Independently settable per-timestamp update (E6-S5 AC1/AC2): only the fields present in
 * `times` are written, so editing one timestamp never disturbs the others or the
 * assignedPositions ridingAssignmentConsumer.ts already wrote for this unit (E6-S5 AC2).
 */
export async function upsertResponseUnitTimes(
  client: DynamoDBDocumentClient,
  tableName: string,
  input: ResponseUnitTimesInput,
): Promise<ResponseUnit> {
  const setClauses = [
    'entityType = :entityType',
    'unitType = :unitType',
    'unitId = :unitId',
    'incidentId = :incidentId',
  ];
  const values: Record<string, unknown> = {
    ':entityType': 'INCIDENT_RESPONSE_UNIT',
    ':unitType': input.unitType,
    ':unitId': input.unitId,
    ':incidentId': input.incidentId,
  };
  for (const field of TIME_FIELDS) {
    const value = input.times[field];
    if (value !== undefined) {
      setClauses.push(`${field} = :${field}`);
      values[`:${field}`] = value;
    }
  }

  const result = await client.send(
    new UpdateCommand({
      TableName: tableName,
      Key: {
        pk: buildDeptScopedPk(input.deptId, 'INCIDENT', input.incidentId),
        sk: `RESPONSE#${input.unitId}`,
      },
      UpdateExpression: `SET ${setClauses.join(', ')}`,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }),
  );
  return toResponseUnit(result.Attributes as Record<string, unknown>);
}
