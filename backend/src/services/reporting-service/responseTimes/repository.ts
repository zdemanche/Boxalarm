import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { queryAllPages } from '../lib/queryAll.js';
import {
  computeResponseTimeAnalytics,
  type ResponseTimeAnalytics,
  type ResponseUnitSample,
} from './compute.js';

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export async function loadResponseUnitSamples(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  fromAlarmAt: number,
  toAlarmAt: number,
): Promise<readonly ResponseUnitSample[]> {
  const incidents = await queryAllPages(client, {
    TableName: tableName,
    IndexName: 'GSI1',
    KeyConditionExpression: 'gsi1pk = :pk AND gsi1sk BETWEEN :from AND :to',
    ExpressionAttributeValues: {
      ':pk': buildDeptScopedPk(deptId),
      ':from': `INCIDENT#${fromAlarmAt}`,
      ':to': `INCIDENT#${toAlarmAt}`,
    },
  });

  const samples: ResponseUnitSample[] = [];
  for (const incident of incidents) {
    const incidentId = incident.incidentId;
    if (typeof incidentId !== 'string' || incidentId.length === 0) {
      continue;
    }
    const units = await queryAllPages(client, {
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': buildDeptScopedPk(deptId, 'INCIDENT', incidentId),
        ':prefix': 'RESPONSE#',
      },
    });
    for (const unit of units) {
      const unitId = unit.unitId;
      if (typeof unitId !== 'string') {
        continue;
      }
      const dispatchedAt = optionalNumber(unit.dispatchedAt);
      const enRouteAt = optionalNumber(unit.enRouteAt);
      const arrivedAt = optionalNumber(unit.arrivedAt);
      samples.push({
        incidentId,
        unitId,
        ...(dispatchedAt !== undefined ? { dispatchedAt } : {}),
        ...(enRouteAt !== undefined ? { enRouteAt } : {}),
        ...(arrivedAt !== undefined ? { arrivedAt } : {}),
      });
    }
  }
  return samples;
}

export async function loadResponseTimeAnalytics(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  fromAlarmAt: number,
  toAlarmAt: number,
): Promise<ResponseTimeAnalytics> {
  const samples = await loadResponseUnitSamples(client, tableName, deptId, fromAlarmAt, toAlarmAt);
  return computeResponseTimeAnalytics(samples);
}
