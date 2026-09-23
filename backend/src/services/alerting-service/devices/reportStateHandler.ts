import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  badRequestProblem,
  extractTraceId,
  serviceUnavailableProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type FieldError,
  type GuardEvent,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
import { logError } from '../dispatches/logger.js';
import { putDeviceState } from './deviceStateRepository.js';

function requiredBoolean(
  body: Record<string, unknown>,
  field: string,
  errors: FieldError[],
): boolean {
  const value = body[field];
  if (typeof value !== 'boolean') {
    errors.push({ field, detail: `${field} is required and must be a boolean` });
    return false;
  }
  return value;
}

function requiredString(
  body: Record<string, unknown>,
  field: string,
  errors: FieldError[],
): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push({ field, detail: `${field} is required and must be a non-empty string` });
    return '';
  }
  return value;
}

async function reportDeviceState(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const deptId = toVerifiedDeptId(principal);
  const memberId = principal.sub;

  let body: Record<string, unknown>;
  try {
    body = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
  } catch {
    return badRequestProblem(traceId, 'request body must be valid JSON');
  }

  const errors: FieldError[] = [];
  const notificationPermission = requiredBoolean(body, 'notificationPermission', errors);
  const criticalAlertPermission = requiredBoolean(body, 'criticalAlertPermission', errors);
  const batteryOptimizationExempt = requiredBoolean(body, 'batteryOptimizationExempt', errors);
  const appVersion = requiredString(body, 'appVersion', errors);
  const osVersion = requiredString(body, 'osVersion', errors);
  if (errors.length > 0) {
    return badRequestProblem(traceId, errors);
  }

  try {
    const { tableName } = readAlertingConfig(process.env);
    const client = createDynamoClient(process.env);
    await putDeviceState(client, tableName, deptId, {
      memberId,
      notificationPermission,
      criticalAlertPermission,
      batteryOptimizationExempt,
      appVersion,
      osVersion,
      reportedAt: Math.floor(Date.now() / 1000),
    });
  } catch (error) {
    logError('devices.reportState.writeFailed', error, { traceId, deptId, memberId });
    return serviceUnavailableProblem(traceId);
  }

  return { statusCode: 204 };
}

export const handler = withAuthorization(reportDeviceState, {
  actionType: 'MEMBER',
  actionId: 'ReportDeviceState',
  resourceType: 'MEMBER',
  resourceId: (event) => event.requestContext.authorizer?.lambda?.sub ?? '',
});
