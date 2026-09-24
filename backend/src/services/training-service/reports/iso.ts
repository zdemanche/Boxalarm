import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  badRequestProblem,
  extractTraceId,
  serviceUnavailableProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  createDocumentClient,
  emitTrainingMetric,
  logError,
  readTrainingConfig,
} from '../client.js';
import { listAttendanceForPeriod } from '../repository.js';
import { buildIsoReport } from './isoReportBuilder.js';

function parsePeriod(raw: string | undefined): number | undefined {
  if (!raw || !/^\d+$/.test(raw)) {
    return undefined;
  }
  const year = Number(raw);
  return year > 0 ? year : undefined;
}

async function getIsoReportInner(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const period = parsePeriod(event.queryStringParameters?.period);
  if (period === undefined) {
    return badRequestProblem(traceId, [
      { field: 'period', detail: 'must be a positive integer year' },
    ]);
  }

  const deptId = toVerifiedDeptId(principal);
  const periodStart = Date.UTC(period, 0, 1);
  const periodEnd = Date.UTC(period + 1, 0, 1) - 1;

  try {
    const config = readTrainingConfig(process.env);
    const client = createDocumentClient(process.env);
    const records = await listAttendanceForPeriod(client, config, deptId, periodStart, periodEnd);
    const report = buildIsoReport(records, period);
    emitTrainingMetric('IsoReportGenerated');
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
    };
  } catch (error) {
    logError('training.reports.iso.failed', error, { deptId, traceId, period });
    emitTrainingMetric(
      'IsoReportFailed',
      error instanceof Error ? error.constructor.name : 'UnknownError',
    );
    return serviceUnavailableProblem(traceId);
  }
}

export const handler = withAuthorization(getIsoReportInner, {
  actionType: 'Boxalarm::Action',
  actionId: 'ViewIsoTrainingReport',
  resourceType: 'Boxalarm::TrainingReport',
  resourceId: () => 'iso',
});
