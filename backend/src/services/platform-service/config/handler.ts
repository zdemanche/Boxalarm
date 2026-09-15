import type {
  APIGatewayProxyEventV2WithLambdaAuthorizer,
  APIGatewayProxyStructuredResultV2,
  Handler,
} from 'aws-lambda';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import type { AuthorizerContext } from '../authorizer/handler.js';
import { assertChiefOrAdmin, ForbiddenError } from '../export/authz.js';
import { getDynamoDocClient } from '../export/awsClients.js';
import { createConfigCache, DEPARTMENT_CONFIG_CACHE_TTL_MS, type ConfigCache } from './cache.js';
import {
  ConflictError,
  configSk,
  getDepartmentConfig,
  isDepartmentConfigType,
  putDepartmentConfig,
  type DepartmentConfigItem,
} from './repository.js';

interface Deps {
  readonly docClient?: DynamoDBDocumentClient;
  readonly cache?: ConfigCache;
  readonly tableName?: string;
}

interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly traceId: string;
}

function problemResponse(
  status: number,
  title: string,
  detail: string,
  traceId: string,
): APIGatewayProxyStructuredResultV2 {
  const body: ProblemDetails = { type: 'about:blank', title, status, detail, traceId };
  return {
    statusCode: status,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify(body),
  };
}

function jsonResponse(status: number, payload: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

function extractTraceId(
  event: APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext>,
): string {
  const header = event.headers?.traceparent ?? event.headers?.Traceparent;
  const fromHeader = header?.split('-')[1];
  return fromHeader && fromHeader.length > 0 ? fromHeader : event.requestContext.requestId;
}

function toConfigResponse(item: DepartmentConfigItem) {
  return {
    configType: item.configType,
    value: item.value,
    version: item.version,
    updatedAt: item.updatedAt,
    updatedBy: item.updatedBy,
  };
}

function readTableName(explicit?: string): string {
  const tableName = explicit ?? process.env.PLATFORM_TABLE_NAME;
  if (!tableName) {
    throw new Error('PLATFORM_TABLE_NAME is required and was not set');
  }
  return tableName;
}

export function createHandler(deps: Deps = {}): Handler {
  const cache = deps.cache ?? createConfigCache({ ttlMs: DEPARTMENT_CONFIG_CACHE_TTL_MS });

  return async (event) => {
    const typedEvent = event as APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext>;
    const traceId = extractTraceId(typedEvent);
    const method = typedEvent.requestContext.http.method.toUpperCase();
    const authorizer = typedEvent.requestContext.authorizer?.lambda;

    if (!authorizer?.deptId || !authorizer.sub) {
      return problemResponse(401, 'Unauthorized', 'missing authorizer context', traceId);
    }

    const configTypeRaw = typedEvent.pathParameters?.configType;
    if (!configTypeRaw || !isDepartmentConfigType(configTypeRaw)) {
      return problemResponse(
        400,
        'Bad Request',
        'configType must be one of STATIONS, RANKS, LOSAP_POINT_RULES, ALERT_RULES, CHECKLIST_DEFAULTS, RETENTION',
        traceId,
      );
    }

    let deptId;
    try {
      deptId = toVerifiedDeptId({ deptId: authorizer.deptId });
    } catch {
      return problemResponse(401, 'Unauthorized', 'invalid deptId on authorizer context', traceId);
    }

    const tableName = readTableName(deps.tableName);
    const docClient = getDynamoDocClient(deps.docClient);
    const pk = buildDeptScopedPk(deptId);
    const sk = configSk(configTypeRaw);

    if (method === 'GET') {
      const item = await cache.getOrLoad(pk, sk, async () => {
        const loaded = await getDepartmentConfig(docClient, {
          tableName,
          deptId,
          configType: configTypeRaw,
        });
        return loaded ?? null;
      });
      if (!item) {
        return problemResponse(404, 'Not Found', `config ${configTypeRaw} not found`, traceId);
      }
      return jsonResponse(200, toConfigResponse(item));
    }

    if (method === 'PUT') {
      try {
        assertChiefOrAdmin(authorizer['cognito:groups'] ?? '');
      } catch (error) {
        if (error instanceof ForbiddenError) {
          return problemResponse(403, 'Forbidden', error.message, traceId);
        }
        throw error;
      }

      let body: { value?: unknown; expectedVersion?: unknown };
      try {
        body = typedEvent.body ? (JSON.parse(typedEvent.body) as typeof body) : {};
      } catch {
        return problemResponse(400, 'Bad Request', 'request body must be JSON', traceId);
      }

      if (!body.value || typeof body.value !== 'object' || Array.isArray(body.value)) {
        return problemResponse(400, 'Bad Request', 'body.value must be a JSON object', traceId);
      }

      const expectedVersion =
        body.expectedVersion === undefined
          ? undefined
          : typeof body.expectedVersion === 'number' && Number.isInteger(body.expectedVersion)
            ? body.expectedVersion
            : null;
      if (expectedVersion === null) {
        return problemResponse(
          400,
          'Bad Request',
          'body.expectedVersion must be an integer when provided',
          traceId,
        );
      }

      try {
        const saved = await putDepartmentConfig(docClient, {
          tableName,
          deptId,
          configType: configTypeRaw,
          value: body.value as Record<string, unknown>,
          actorId: authorizer.sub,
          ...(expectedVersion !== undefined ? { expectedVersion } : {}),
        });
        cache.invalidate(pk, sk);
        return jsonResponse(200, toConfigResponse(saved));
      } catch (error) {
        if (error instanceof ConflictError) {
          return problemResponse(
            409,
            'Conflict',
            'department config was modified concurrently; reload and retry',
            traceId,
          );
        }
        throw error;
      }
    }

    return problemResponse(405, 'Method Not Allowed', `unsupported method ${method}`, traceId);
  };
}

export const handler = createHandler();
