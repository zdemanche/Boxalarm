import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { GetCommand, TransactWriteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { withAuthorization, type CedarPrincipalContext, type GuardEvent } from '@boxalarm/authz';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { buildOutboxRecord } from '@boxalarm/outbox';
import { emitIncidentMetric, problemResponse, resolveTraceId } from './authContext.js';
import { getDocumentClient, getTableName } from './repository.js';
import { getNerisDeptSettings } from './nerisSettings.js';
import { nerisApiFromEnv } from './reportContext.js';
import { describeNerisIssue } from './nerisValidation.js';
import { readJsonObject } from './routeInput.js';
import { zonedMonth, zonedMonthBounds } from './neris/zonedTime.js';

const MONTH_PATTERN = /^(20[2-9]\d)-(0[1-9]|1[0-2])$/;

/** NERIS's `month_year` format, `MM/YYYY`. */
export function toNerisMonthYear(month: string): string {
  const [year, mm] = month.split('-');
  return `${mm}/${year}`;
}

/**
 * POST /api/v1/incidents/no-activity-reports  {month: 'YYYY-MM'} — tells NERIS the department
 * ran no calls that month (POST /no_activity_report/{entity}, body `{month_year: 'MM/YYYY'}`).
 * Only for a month that has closed and has no local incident; filed once per month.
 */
async function inner(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = resolveTraceId(event.headers, event.requestContext.requestId);
  const deptId = toVerifiedDeptId(principal);
  const parsed = readJsonObject(event, traceId);
  if (!parsed.ok) return parsed.problem;
  const month = parsed.body.month;
  if (typeof month !== 'string' || !MONTH_PATTERN.test(month)) {
    return problemResponse(400, 'Bad Request', 'month is required as YYYY-MM.', traceId);
  }
  const client = getDocumentClient();
  const tableName = getTableName(process.env);
  try {
    const settings = await getNerisDeptSettings(client, tableName, deptId);
    // Months are the department's own calendar months (review minor 6).
    if (month >= zonedMonth(Date.now(), settings.timeZone)) {
      return problemResponse(
        400,
        'Bad Request',
        'A no-activity report can only be filed for a month that has ended.',
        traceId,
      );
    }
    if (!settings.departmentNerisId || !settings.submissionsEnabled) {
      return problemResponse(
        409,
        'Conflict',
        'NERIS submissions are not set up or are switched off for the department.',
        traceId,
        { code: 'NOT_CONFIGURED' },
      );
    }
    const pk = buildDeptScopedPk(deptId, 'NERIS');
    const existing = await client.send(
      new GetCommand({ TableName: tableName, Key: { pk, sk: `NO_ACTIVITY#${month}` } }),
    );
    if (existing.Item) {
      return problemResponse(
        409,
        'Conflict',
        `A no-activity report for ${month} is already on file.`,
        traceId,
        {
          code: 'ALREADY_FILED',
          nerisUid: existing.Item.nerisUid ?? null,
        },
      );
    }
    const { from, to } = zonedMonthBounds(month, settings.timeZone);
    const incidents = await client.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'gsi1pk = :pk AND gsi1sk BETWEEN :from AND :to',
        ExpressionAttributeValues: {
          ':pk': buildDeptScopedPk(deptId),
          ':from': `INCIDENT#${from}`,
          ':to': `INCIDENT#${to}`,
        },
        Select: 'COUNT',
      }),
    );
    if ((incidents.Count ?? 0) > 0) {
      return problemResponse(
        409,
        'Conflict',
        `${month} has ${incidents.Count} incident report${incidents.Count === 1 ? '' : 's'}; a no-activity report is only for a month with none.`,
        traceId,
        { code: 'MONTH_HAS_INCIDENTS' },
      );
    }

    const api = await nerisApiFromEnv();
    // Idempotent (review minor 7): if an earlier attempt filed it with NERIS but the local
    // record was not written, adopt NERIS's report instead of filing a second one.
    const onFile = await api.listNoActivityReports(
      settings.departmentNerisId,
      toNerisMonthYear(month),
    );
    const adopted = onFile.ok ? onFile.reports[0] : undefined;
    const result = adopted
      ? { ok: true as const, httpStatus: 200, nerisUid: adopted.nerisUid }
      : await api.createNoActivityReport(settings.departmentNerisId, toNerisMonthYear(month));
    if (!result.ok) {
      emitIncidentMetric('NoActivityReportRejected');
      return result.kind === 'validation'
        ? problemResponse(
            422,
            'Unprocessable Entity',
            'NERIS rejected the no-activity report.',
            traceId,
            {
              code: 'NERIS_REJECTED',
              blocking: result.issues.map(describeNerisIssue),
            },
          )
        : problemResponse(
            502,
            'Bad Gateway',
            `NERIS answered HTTP ${result.httpStatus}. Try again shortly.`,
            traceId,
            {
              code: 'NERIS_UNAVAILABLE',
            },
          );
    }
    const filedAt = new Date().toISOString();
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: {
                pk,
                sk: `NO_ACTIVITY#${month}`,
                entityType: 'NERIS_NO_ACTIVITY_REPORT',
                month,
                ...(result.nerisUid ? { nerisUid: result.nerisUid } : {}),
                filedBy: principal.sub,
                filedAt,
              },
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: buildOutboxRecord(
                deptId,
                'incident-service',
                'neris.no_activity.submitted',
                traceId,
                {
                  deptId,
                  month,
                  ...(result.nerisUid ? { nerisUid: result.nerisUid } : {}),
                  filedBy: principal.sub,
                },
              ),
            },
          },
        ],
      }),
    );
    emitIncidentMetric('NoActivityReportFiled');
    return {
      statusCode: 201,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        month,
        nerisUid: result.nerisUid ?? null,
        filedBy: principal.sub,
        filedAt,
      }),
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'incident.noActivityReport.failed',
        correlationId: traceId,
        deptId,
        month,
        message: error instanceof Error ? error.message : undefined,
      }),
    );
    emitIncidentMetric('NoActivityReportFailed');
    return problemResponse(
      503,
      'Service Unavailable',
      'Unable to file the no-activity report.',
      traceId,
    );
  }
}

export const handler = withAuthorization(inner, {
  actionType: 'Boxalarm::Action',
  actionId: 'FileNoActivityReport',
  resourceType: 'Boxalarm::Department',
  resourceId: (event) => event.requestContext.authorizer?.lambda?.deptId ?? '',
});
