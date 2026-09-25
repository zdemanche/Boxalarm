import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import type { ExportFormat, ExportJob, ReportName } from './render.js';

function jobKey(deptId: VerifiedDeptId, jobId: string): { pk: string; sk: string } {
  return { pk: buildDeptScopedPk(deptId, 'REPORTING_EXPORT', jobId), sk: 'JOB' };
}

export async function putExportJob(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  job: ExportJob,
): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        ...jobKey(deptId, job.jobId),
        entityType: 'REPORTING_EXPORT_JOB',
        ...job,
        deptId,
      },
    }),
  );
}

export async function getExportJob(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  jobId: string,
): Promise<ExportJob | undefined> {
  const result = await client.send(
    new GetCommand({
      TableName: tableName,
      Key: jobKey(deptId, jobId),
    }),
  );
  if (!result.Item) {
    return undefined;
  }
  const item = result.Item;
  return {
    jobId: item.jobId as string,
    report: item.report as ReportName,
    format: item.format as ExportFormat,
    params: (item.params as Record<string, string> | undefined) ?? {},
    status: item.status as ExportJob['status'],
    requestedBy: item.requestedBy as string,
    requestedAt: item.requestedAt as string,
    ...(typeof item.detail === 'string' ? { detail: item.detail } : {}),
    ...(typeof item.objectKey === 'string' ? { objectKey: item.objectKey } : {}),
  };
}

export async function markExportJob(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  jobId: string,
  status: 'COMPLETED' | 'FAILED',
  fields: { readonly detail?: string; readonly objectKey?: string },
): Promise<void> {
  const names: Record<string, string> = { '#status': 'status' };
  const values: Record<string, unknown> = { ':status': status };
  const sets = ['#status = :status'];
  if (fields.detail !== undefined) {
    names['#detail'] = 'detail';
    values[':detail'] = fields.detail;
    sets.push('#detail = :detail');
  }
  if (fields.objectKey !== undefined) {
    names['#objectKey'] = 'objectKey';
    values[':objectKey'] = fields.objectKey;
    sets.push('#objectKey = :objectKey');
  }
  await client.send(
    new UpdateCommand({
      TableName: tableName,
      Key: jobKey(deptId, jobId),
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: 'attribute_exists(pk)',
    }),
  );
}
