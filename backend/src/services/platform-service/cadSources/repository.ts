import type { VerifiedDeptId } from '@boxalarm/dept-scope';
import { getDynamoDocClient } from '../export/awsClients.js';
import { getDepartmentConfig } from '../config/repository.js';

export const CAD_INGRESS = 'CAD_INGRESS';

export function readTableName(): string {
  const tableName = process.env.PLATFORM_TABLE_NAME;
  if (!tableName) throw new Error('PLATFORM_TABLE_NAME is required and was not set');
  return tableName;
}

export async function loadCadIngress(deptId: VerifiedDeptId) {
  return getDepartmentConfig(getDynamoDocClient(), {
    tableName: readTableName(),
    deptId,
    configType: CAD_INGRESS,
  });
}
