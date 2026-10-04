import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  badRequestProblem,
  forbiddenProblem,
  notFoundProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { createDynamoClient, readPersonnelConfig } from '../dynamoClient.js';
import { parseDeviceId, withoutDevice, writePushDevices } from './pushDevices.js';

function extractTraceId(event: GuardEvent): string {
  const traceparent = event.headers?.traceparent ?? event.headers?.Traceparent;
  const traceId = traceparent?.split('-')[1];
  return traceId && traceId.length > 0 ? traceId : randomUUID();
}

function emitRevokeMetric(outcome: 'Revoked' | 'Failed', reason?: string): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/push-token',
            Dimensions: reason ? [[], ['Reason']] : [[]],
            Metrics: [{ Name: `PushToken${outcome}`, Unit: 'Count' }],
          },
        ],
      },
      ...(reason ? { Reason: reason } : {}),
      [`PushToken${outcome}`]: 1,
    }),
  );
}

async function revokeToken(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const memberId = event.pathParameters?.memberId;
  if (!memberId) {
    return badRequestProblem(traceId, 'memberId path parameter is required');
  }
  // A device may only revoke its own member's push token. Cedar cannot compare the caller
  // with the path member (no entity attributes reach it), and RegisterPushToken /
  // RevokePushToken are every-role actions, so without this any member could point
  // another member's pages at their own device - or strip that member's token.
  if (memberId !== principal.sub) {
    return forbiddenProblem(traceId);
  }

  // Sign-out removes only this device's entry (`?deviceId=`); the member's other devices keep
  // being paged. Without a deviceId (an app build that predates multi-device support) only the
  // legacy entry is removed.
  let deviceId: string | undefined;
  try {
    deviceId = parseDeviceId(event.queryStringParameters?.deviceId);
  } catch (error) {
    return badRequestProblem(traceId, error instanceof Error ? error.message : 'invalid deviceId');
  }

  const deptId = toVerifiedDeptId(principal);
  const client = createDynamoClient(process.env);
  const config = readPersonnelConfig(process.env);

  let outcome;
  try {
    outcome = await writePushDevices(client, config.tableName, deptId, memberId, (current) =>
      withoutDevice(current, deviceId),
    );
  } catch (error) {
    const cancellationReasons =
      error instanceof TransactionCanceledException
        ? (error.CancellationReasons?.map((r) => r.Code) ?? [])
        : undefined;
    console.error(
      JSON.stringify({
        event: 'personnel.pushToken.revoke.failed',
        service: 'personnel-service',
        correlationId: traceId,
        memberId,
        reason: error instanceof Error ? error.constructor.name : 'UnknownError',
        message: error instanceof Error ? error.message : String(error),
        cancellationReasons,
      }),
    );
    emitRevokeMetric('Failed', 'UnknownError');
    throw error;
  }
  if (outcome === 'not_found') {
    emitRevokeMetric('Failed', 'MemberNotFound');
    return notFoundProblem(traceId, `member ${memberId} was not found`);
  }

  console.log(
    JSON.stringify({
      event: 'personnel.pushToken.revoked',
      service: 'personnel-service',
      correlationId: traceId,
      memberId,
      deviceId: deviceId ?? null,
    }),
  );
  emitRevokeMetric('Revoked');

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      memberId,
      channel: 'PUSH',
      revoked: true,
      ...(deviceId ? { deviceId } : {}),
    }),
  };
}

export const handler = withAuthorization(revokeToken, {
  actionType: 'Boxalarm::Action',
  actionId: 'RevokePushToken',
  resourceType: 'Boxalarm::Member',
  resourceId: (event) => event.pathParameters?.memberId ?? '',
});
