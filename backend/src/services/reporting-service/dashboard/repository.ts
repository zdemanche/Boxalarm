import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { queryAllPages } from '../lib/queryAll.js';
import { assembleDashboard, type DashboardView } from './assemble.js';

export async function loadDashboard(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  nowMs: number,
): Promise<DashboardView> {
  const items = await queryAllPages(client, {
    TableName: tableName,
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: { ':pk': buildDeptScopedPk(deptId, 'REPORTING_ROLLUP') },
  });
  return assembleDashboard(items, nowMs);
}
