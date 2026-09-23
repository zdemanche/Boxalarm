import { randomUUID } from 'node:crypto';
import type {
  APIGatewayProxyEventV2WithLambdaAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import { createAuthzClient, readAuthzConfig } from './client.js';
import {
  AuthzUnavailableError,
  batchIsAuthorized,
  isAuthorized,
  type CedarPrincipalContext,
} from './decide.js';
import { emitAuthzMetric, emitInvocationMetric } from './metrics.js';
import {
  forbiddenProblem,
  serviceUnavailableProblem,
  unauthorizedProblem,
} from './problemDetails.js';

type RawAuthorizerContext = Partial<CedarPrincipalContext>;

export type GuardEvent = APIGatewayProxyEventV2WithLambdaAuthorizer<RawAuthorizerContext>;

export interface CedarActionRef {
  readonly actionType: string;
  readonly actionId: string;
  readonly resourceType: string;
}

export interface WithAuthorizationOptions extends CedarActionRef {
  readonly resourceId: (event: GuardEvent) => string;
  readonly alarmOnInvocation?: string;
  readonly client?: VerifiedPermissionsClient;
}

export interface WithBatchAuthorizationOptions extends CedarActionRef {
  readonly resourceIds: (event: GuardEvent) => readonly string[];
  readonly client?: VerifiedPermissionsClient;
}

export interface BatchAuthorizationResult {
  readonly allowedResourceIds: readonly string[];
}

export function extractBearerToken(event: GuardEvent): string | undefined {
  const header = event.headers?.authorization ?? event.headers?.Authorization;
  if (!header) {
    return undefined;
  }
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return undefined;
  }
  return token;
}

export function extractTraceId(event: GuardEvent): string {
  const traceparent = event.headers?.traceparent ?? event.headers?.Traceparent;
  const traceId = traceparent?.split('-')[1];
  return traceId && traceId.length > 0 ? traceId : randomUUID();
}

function isValidPrincipal(
  value: RawAuthorizerContext | null | undefined,
): value is CedarPrincipalContext {
  return (
    !!value &&
    typeof value.sub === 'string' &&
    value.sub.length > 0 &&
    typeof value.deptId === 'string' &&
    value.deptId.length > 0 &&
    typeof value['cognito:groups'] === 'string'
  );
}

function logAuthzOutcome(
  event: string,
  reason: string,
  correlationId: string,
  deptId?: string,
): void {
  console.error(
    JSON.stringify({
      event,
      service: 'authz',
      reason,
      correlationId,
      ...(deptId ? { deptId } : {}),
    }),
  );
}

interface Resolved {
  readonly token: string;
  readonly principal: CedarPrincipalContext;
}

function resolvePrincipal(event: GuardEvent, traceId: string): Resolved | undefined {
  const token = extractBearerToken(event);
  const principal = event.requestContext.authorizer?.lambda;
  if (!token || !isValidPrincipal(principal)) {
    logAuthzOutcome('authz.denied', 'MissingOrInvalidPrincipal', traceId, principal?.deptId);
    emitAuthzMetric('Denied', 'MissingOrInvalidPrincipal');
    return undefined;
  }
  return { token, principal };
}

export function withAuthorization<TResult extends APIGatewayProxyResultV2>(
  inner: (event: GuardEvent, principal: CedarPrincipalContext) => Promise<TResult>,
  options: WithAuthorizationOptions,
): (event: GuardEvent) => Promise<TResult | APIGatewayProxyResultV2> {
  return async (event) => {
    const traceId = extractTraceId(event);
    if (options.alarmOnInvocation) {
      emitInvocationMetric(options.alarmOnInvocation);
    }

    const resolved = resolvePrincipal(event, traceId);
    if (!resolved) {
      return unauthorizedProblem(traceId);
    }
    const { token, principal } = resolved;

    try {
      const client = createAuthzClient(process.env, options.client);
      const config = readAuthzConfig(process.env);
      const allowed = await isAuthorized(client, config, token, {
        actionType: options.actionType,
        actionId: options.actionId,
        resourceType: options.resourceType,
        resourceId: options.resourceId(event),
      });
      if (!allowed) {
        logAuthzOutcome('authz.denied', 'CedarDeny', traceId, principal.deptId);
        emitAuthzMetric('Denied', 'CedarDeny');
        return forbiddenProblem(traceId);
      }
      emitAuthzMetric('Allowed');
      return await inner(event, principal);
    } catch (error) {
      if (error instanceof AuthzUnavailableError) {
        logAuthzOutcome('authz.unavailable', error.reason, traceId, principal.deptId);
        emitAuthzMetric('Denied', error.reason);
        return serviceUnavailableProblem(traceId);
      }
      throw error;
    }
  };
}

export function withBatchAuthorization(
  inner: (
    event: GuardEvent,
    principal: CedarPrincipalContext,
    result: BatchAuthorizationResult,
  ) => Promise<APIGatewayProxyResultV2>,
  options: WithBatchAuthorizationOptions,
): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  return async (event) => {
    const traceId = extractTraceId(event);
    const resolved = resolvePrincipal(event, traceId);
    if (!resolved) {
      return unauthorizedProblem(traceId);
    }
    const { token, principal } = resolved;

    try {
      const client = createAuthzClient(process.env, options.client);
      const config = readAuthzConfig(process.env);
      const decisions = await batchIsAuthorized(
        client,
        config,
        token,
        options.actionType,
        options.actionId,
        options.resourceType,
        options.resourceIds(event),
      );
      const allowedResourceIds = decisions
        .filter((decision) => decision.allowed)
        .map((d) => d.resourceId);
      emitAuthzMetric('Allowed');
      return await inner(event, principal, { allowedResourceIds });
    } catch (error) {
      if (error instanceof AuthzUnavailableError) {
        logAuthzOutcome('authz.unavailable', error.reason, traceId, principal.deptId);
        emitAuthzMetric('Denied', error.reason);
        return serviceUnavailableProblem(traceId);
      }
      throw error;
    }
  };
}
