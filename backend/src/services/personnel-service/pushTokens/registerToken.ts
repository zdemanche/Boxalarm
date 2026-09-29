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
import {
  parseDeviceId,
  withRegisteredDevice,
  writePushDevices,
  type ContactChannelEntry,
} from './pushDevices.js';

export type { ContactChannelEntry } from './pushDevices.js';

const ALLOWED_PLATFORMS = ['APNS', 'FCM'] as const;
type Platform = (typeof ALLOWED_PLATFORMS)[number];

export interface RegisterTokenBody {
  readonly platform: Platform;
  readonly token: string;
  /**
   * The app installation registering (pushDevices.ts). Optional for app builds that predate
   * multi-device support; without it the registration replaces the member's legacy entry.
   */
  readonly deviceId?: string;
}

export function parseRegisterBody(raw: string | undefined | null): RegisterTokenBody {
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : undefined;
  } catch {
    throw new Error('body must be valid JSON');
  }
  const body = (parsed ?? {}) as Partial<Record<string, unknown>>;
  const token = body.token;
  const platform = body.platform;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('token is required and must be a non-empty string');
  }
  if (typeof platform !== 'string' || !ALLOWED_PLATFORMS.includes(platform as Platform)) {
    throw new Error('platform is required and must be one of APNS, FCM');
  }
  const deviceId = parseDeviceId(body.deviceId);
  return { platform: platform as Platform, token, ...(deviceId ? { deviceId } : {}) };
}

function extractTraceId(event: GuardEvent): string {
  const traceparent = event.headers?.traceparent ?? event.headers?.Traceparent;
  const traceId = traceparent?.split('-')[1];
  return traceId && traceId.length > 0 ? traceId : randomUUID();
}

function emitPushTokenMetric(outcome: 'Registered' | 'Failed', reason?: string): void {
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

async function registerToken(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const memberId = event.pathParameters?.memberId;
  if (!memberId) {
    return badRequestProblem(traceId, 'memberId path parameter is required');
  }
  // A device may only register its own member's push token. Cedar cannot compare the caller
  // with the path member (no entity attributes reach it), and RegisterPushToken /
  // RevokePushToken are every-role actions, so without this any member could point
  // another member's pages at their own device - or strip that member's token.
  if (memberId !== principal.sub) {
    return forbiddenProblem(traceId);
  }

  let body: RegisterTokenBody;
  try {
    body = parseRegisterBody(event.body);
  } catch (error) {
    return badRequestProblem(traceId, error instanceof Error ? error.message : 'invalid body');
  }

  const deptId = toVerifiedDeptId(principal);
  const client = createDynamoClient(process.env);
  const config = readPersonnelConfig(process.env);

  const entry: ContactChannelEntry & { token: string } = {
    channel: 'PUSH',
    platform: body.platform,
    token: body.token,
    valid: true,
    registeredAt: Date.now(),
    ...(body.deviceId ? { deviceId: body.deviceId } : {}),
  };

  let outcome;
  try {
    outcome = await writePushDevices(client, config.tableName, deptId, memberId, (current) =>
      withRegisteredDevice(current, entry),
    );
  } catch (error) {
    const cancellationReasons =
      error instanceof TransactionCanceledException
        ? (error.CancellationReasons?.map((r) => r.Code) ?? [])
        : undefined;
    console.error(
      JSON.stringify({
        event: 'personnel.pushToken.register.failed',
        service: 'personnel-service',
        correlationId: traceId,
        memberId,
        reason: error instanceof Error ? error.constructor.name : 'UnknownError',
        message: error instanceof Error ? error.message : String(error),
        cancellationReasons,
      }),
    );
    emitPushTokenMetric('Failed', 'UnknownError');
    throw error;
  }
  if (outcome === 'not_found') {
    emitPushTokenMetric('Failed', 'MemberNotFound');
    return notFoundProblem(traceId, `member ${memberId} was not found`);
  }

  console.log(
    JSON.stringify({
      event: 'personnel.pushToken.registered',
      service: 'personnel-service',
      correlationId: traceId,
      memberId,
      deviceId: body.deviceId ?? null,
    }),
  );
  emitPushTokenMetric('Registered');

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      memberId,
      channel: 'PUSH',
      registered: true,
      ...(body.deviceId ? { deviceId: body.deviceId } : {}),
    }),
  };
}

export const handler = withAuthorization(registerToken, {
  actionType: 'Boxalarm::Action',
  actionId: 'RegisterPushToken',
  resourceType: 'Boxalarm::Member',
  resourceId: (event) => event.pathParameters?.memberId ?? '',
});
