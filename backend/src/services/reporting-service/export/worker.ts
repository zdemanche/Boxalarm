import type { Handler } from 'aws-lambda';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { createDynamoDocClient, readReportingServiceConfig } from '../awsClients.js';
import { logError } from '../logger.js';
import { buildExportTable } from './buildReport.js';
import { createExportS3Client, readExportsBucket } from './clients.js';
import { markExportJob } from './repository.js';
import { renderCsv, renderPdf, type ExportFormat, type ReportName } from './render.js';

const METRICS_NAMESPACE = 'Boxalarm/ReportingService';

export interface ReportingExportWorkerEvent {
  readonly jobId: string;
  readonly deptId: string;
  readonly report: ReportName;
  readonly format: ExportFormat;
  readonly params: Readonly<Record<string, string>>;
}

export const handler: Handler<ReportingExportWorkerEvent, void> = async (event) => {
  const deptId = toVerifiedDeptId({ deptId: event.deptId });
  const { tableName } = readReportingServiceConfig(process.env);
  const client = createDynamoDocClient();
  try {
    const table = await buildExportTable(event.report, event.params, deptId, client, tableName);
    const body = event.format === 'pdf' ? renderPdf(table) : Buffer.from(renderCsv(table), 'utf8');
    const contentType = event.format === 'pdf' ? 'application/pdf' : 'text/csv';
    const objectKey = `${deptId}/${event.jobId}/report.${event.format}`;
    await createExportS3Client().send(
      new PutObjectCommand({
        Bucket: readExportsBucket(process.env),
        Key: objectKey,
        Body: body,
        ContentType: contentType,
      }),
    );
    await markExportJob(client, tableName, deptId, event.jobId, 'COMPLETED', { objectKey });
    emitOutcomeMetric(METRICS_NAMESPACE, 'ReportingExportCompleted');
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'export failed';
    logError('reporting.export.worker_failed', error, { jobId: event.jobId, deptId });
    try {
      await markExportJob(client, tableName, deptId, event.jobId, 'FAILED', { detail });
    } catch (markError) {
      logError('reporting.export.mark_failed', markError, { jobId: event.jobId, deptId });
    }
    emitOutcomeMetric(METRICS_NAMESPACE, 'ReportingExportFailed');
  }
};
