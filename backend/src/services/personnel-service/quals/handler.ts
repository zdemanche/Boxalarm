import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  notFoundProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { createDynamoDocClient, readPersonnelServiceConfig } from '../awsClients.js';
import { CertNotFoundError, memberExists, putQual, readQuals } from './repository.js';

interface PutQualsBody {
  readonly qualCode: string;
  readonly grantedByCertId: string | null;
}

function unprocessableEntityProblem(traceId: string, detail: string): APIGatewayProxyResultV2 {
  return {
    statusCode: 422,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify({
      type: 'https://boxalarm.dev/problems/unprocessable-entity',
      title: 'Unprocessable Entity',
      status: 422,
      detail,
      traceId,
    }),
  };
}

function extractTraceId(event: GuardEvent): string {
  const traceparent = event.headers?.traceparent ?? event.headers?.Traceparent;
  const traceId = traceparent?.split('-')[1];
  return traceId && traceId.length > 0 ? traceId : randomUUID();
}

function emitQualsWriteMetric(outcome: 'Succeeded' | 'Failed', reason?: string): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/PersonnelService',
            Dimensions: reason ? [[], ['Reason']] : [[]],
            Metrics: [{ Name: `PersonnelQualsWrite${outcome}`, Unit: 'Count' }],
          },
        ],
      },
      ...(reason ? { Reason: reason } : {}),
      [`PersonnelQualsWrite${outcome}`]: 1,
    }),
  );
}

function parsePutQualsBody(body: string | undefined): PutQualsBody | undefined {
  if (!body) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const qualCode = record.qualCode;
  if (typeof qualCode !== 'string' || qualCode.length === 0) {
    return undefined;
  }
  const grantedByCertId = record.grantedByCertId;
  if (
    grantedByCertId !== undefined &&
    grantedByCertId !== null &&
    typeof grantedByCertId !== 'string'
  ) {
    return undefined;
  }
  return { qualCode, grantedByCertId: grantedByCertId ?? null };
}

async function innerGetQualsHandler(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const memberId = event.pathParameters?.memberId;
  if (!memberId) {
    return notFoundProblem(traceId, 'memberId path parameter is required');
  }

  const deptId = toVerifiedDeptId(principal);
  const config = readPersonnelServiceConfig(process.env);
  const client = createDynamoDocClient();
  const quals = await readQuals(client, config.tableName, deptId, memberId);

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(quals),
  };
}

async function innerPutQualsHandler(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const memberId = event.pathParameters?.memberId;
  if (!memberId) {
    return notFoundProblem(traceId, 'memberId path parameter is required');
  }

  const parsedBody = parsePutQualsBody(event.body);
  if (!parsedBody) {
    return unprocessableEntityProblem(
      traceId,
      'qualCode is required and must be a non-empty string; grantedByCertId, if present, must be a string or null',
    );
  }

  const deptId = toVerifiedDeptId(principal);
  const config = readPersonnelServiceConfig(process.env);
  const client = createDynamoDocClient();

  const exists = await memberExists(client, config.tableName, deptId, memberId);
  if (!exists) {
    return notFoundProblem(traceId, 'Member was not found');
  }

  try {
    const qual = await putQual(
      client,
      config.tableName,
      deptId,
      memberId,
      parsedBody.qualCode,
      parsedBody.grantedByCertId,
      traceId,
    );
    emitQualsWriteMetric('Succeeded');
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(qual),
    };
  } catch (error) {
    if (error instanceof CertNotFoundError) {
      return notFoundProblem(traceId, 'Certification was not found');
    }
    emitQualsWriteMetric(
      'Failed',
      error instanceof Error ? error.constructor.name : 'UnknownError',
    );
    throw error;
  }
}

export const getQualsHandler = withAuthorization(innerGetQualsHandler, {
  actionType: 'PersonnelService',
  actionId: 'GetQuals',
  resourceType: 'Member',
  resourceId: (event) => event.pathParameters?.memberId ?? '',
});

export const putQualsHandler = withAuthorization(innerPutQualsHandler, {
  actionType: 'PersonnelService',
  actionId: 'UpdateQuals',
  resourceType: 'Member',
  resourceId: (event) => event.pathParameters?.memberId ?? '',
});
