import { randomUUID } from 'node:crypto';
import type {
  APIGatewayProxyEventV2WithLambdaAuthorizer,
  APIGatewayEventRequestContextLambdaAuthorizer,
  APIGatewayProxyHandlerV2WithLambdaAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import type { AuthorizerContext } from '../../platform-service/authorizer/handler.js';
import {
  ForbiddenError,
  ServiceUnavailableError,
  assertOccupancyWriteAuthorized,
} from './authorization.js';
import { readOccupancyAuthorizationConfig, readOccupancyServiceConfig } from './config.js';
import { logStructuredError } from './log.js';
import { toProblemResponse } from './problemDetails.js';
import {
  OccupancyNotFoundError,
  createOccupancy,
  getOccupancyById,
  updateOccupancy,
} from './repository.js';
import type { OccupancyRecord } from './repository.js';
import {
  ValidationError,
  parseOccupancyRequestBody,
  validateCreateOccupancyInput,
  validateUpdateOccupancyInput,
} from './validation.js';

type OccupancyEvent = APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext>;

function extractBearerToken(event: OccupancyEvent): string | undefined {
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

function getPrincipal(event: OccupancyEvent): AuthorizerContext | undefined {
  const authorizer = event.requestContext.authorizer as
    APIGatewayEventRequestContextLambdaAuthorizer<AuthorizerContext> | undefined;
  return authorizer?.lambda;
}

function emitOccupancyMetric(outcome: string, reason?: string): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/Inspections/Occupancy',
            Dimensions: reason ? [[], ['Reason']] : [[]],
            Metrics: [{ Name: outcome, Unit: 'Count' }],
          },
        ],
      },
      ...(reason ? { Reason: reason } : {}),
      [outcome]: 1,
    }),
  );
}

function toOccupancyResponseBody(record: OccupancyRecord): Record<string, unknown> {
  return {
    occupancyId: record.occupancyId,
    address: record.address,
    occupancyType: record.occupancyType,
    contacts: record.contacts,
    hazards: record.hazards,
    latitude: record.latitude,
    longitude: record.longitude,
  };
}

function unauthorizedResponse(traceId: string): APIGatewayProxyStructuredResultV2 {
  return toProblemResponse(401, 'Unauthorized', 'A valid bearer token is required', traceId);
}

async function authorizeWrite(
  occupancyId: string,
  bearerToken: string,
  traceId: string,
): Promise<APIGatewayProxyStructuredResultV2 | undefined> {
  try {
    await assertOccupancyWriteAuthorized(
      readOccupancyAuthorizationConfig(process.env),
      bearerToken,
      occupancyId,
      traceId,
    );
    return undefined;
  } catch (error) {
    if (error instanceof ForbiddenError) {
      emitOccupancyMetric('WriteDenied', 'Forbidden');
      return toProblemResponse(
        403,
        'Forbidden',
        'You are not authorized to write occupancies',
        traceId,
      );
    }
    if (error instanceof ServiceUnavailableError) {
      emitOccupancyMetric('WriteDenied', 'ServiceUnavailable');
      return toProblemResponse(
        503,
        'Service Unavailable',
        'Authorization service is temporarily unavailable',
        traceId,
      );
    }
    throw error;
  }
}

export const createOccupancyHandler: APIGatewayProxyHandlerV2WithLambdaAuthorizer<
  AuthorizerContext
> = async (event) => {
  const occupancyEvent = event as OccupancyEvent;
  const traceId = occupancyEvent.requestContext.requestId;
  const principal = getPrincipal(occupancyEvent);
  const bearerToken = extractBearerToken(occupancyEvent);
  if (!principal || !bearerToken) {
    return unauthorizedResponse(traceId);
  }

  const occupancyId = `OCC-${randomUUID()}`;
  const authError = await authorizeWrite(occupancyId, bearerToken, traceId);
  if (authError) {
    return authError;
  }

  let input;
  try {
    input = validateCreateOccupancyInput(parseOccupancyRequestBody(occupancyEvent.body));
  } catch (error) {
    if (error instanceof ValidationError) {
      return toProblemResponse(
        400,
        'Invalid Occupancy',
        'The request body failed validation',
        traceId,
        error.errors,
      );
    }
    throw error;
  }

  try {
    const record = await createOccupancy(
      readOccupancyServiceConfig(process.env),
      principal,
      occupancyId,
      input,
      principal.sub,
      traceId,
    );
    emitOccupancyMetric('OccupancyCreated');
    return {
      statusCode: 201,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(toOccupancyResponseBody(record)),
    };
  } catch (error) {
    logStructuredError('occupancy.create.handler_failed', traceId, {
      occupancyId,
      message: error instanceof Error ? error.message : undefined,
    });
    emitOccupancyMetric('OccupancyCreated', 'Error');
    return toProblemResponse(500, 'Internal Server Error', 'Unable to create occupancy', traceId);
  }
};

export const getOccupancyHandler: APIGatewayProxyHandlerV2WithLambdaAuthorizer<
  AuthorizerContext
> = async (event) => {
  const occupancyEvent = event as OccupancyEvent;
  const traceId = occupancyEvent.requestContext.requestId;
  const principal = getPrincipal(occupancyEvent);
  if (!principal) {
    return unauthorizedResponse(traceId);
  }

  const occupancyId = occupancyEvent.pathParameters?.id;
  if (!occupancyId) {
    return toProblemResponse(404, 'Occupancy Not Found', 'occupancy id is required', traceId);
  }

  try {
    const record = await getOccupancyById(
      readOccupancyServiceConfig(process.env),
      principal,
      occupancyId,
    );
    if (!record) {
      return toProblemResponse(
        404,
        'Occupancy Not Found',
        `No occupancy exists with id ${occupancyId}`,
        traceId,
      );
    }
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(toOccupancyResponseBody(record)),
    };
  } catch (error) {
    logStructuredError('occupancy.get.handler_failed', traceId, {
      occupancyId,
      message: error instanceof Error ? error.message : undefined,
    });
    return toProblemResponse(500, 'Internal Server Error', 'Unable to retrieve occupancy', traceId);
  }
};

export const updateOccupancyHandler: APIGatewayProxyHandlerV2WithLambdaAuthorizer<
  AuthorizerContext
> = async (event) => {
  const occupancyEvent = event as OccupancyEvent;
  const traceId = occupancyEvent.requestContext.requestId;
  const principal = getPrincipal(occupancyEvent);
  const bearerToken = extractBearerToken(occupancyEvent);
  if (!principal || !bearerToken) {
    return unauthorizedResponse(traceId);
  }

  const occupancyId = occupancyEvent.pathParameters?.id;
  if (!occupancyId) {
    return toProblemResponse(404, 'Occupancy Not Found', 'occupancy id is required', traceId);
  }

  const authError = await authorizeWrite(occupancyId, bearerToken, traceId);
  if (authError) {
    return authError;
  }

  let input;
  try {
    input = validateUpdateOccupancyInput(parseOccupancyRequestBody(occupancyEvent.body));
  } catch (error) {
    if (error instanceof ValidationError) {
      return toProblemResponse(
        400,
        'Invalid Occupancy',
        'The request body failed validation',
        traceId,
        error.errors,
      );
    }
    throw error;
  }

  const serviceConfig = readOccupancyServiceConfig(process.env);

  try {
    const existing = await getOccupancyById(serviceConfig, principal, occupancyId);
    if (!existing) {
      emitOccupancyMetric('OccupancyUpdated', 'NotFound');
      return toProblemResponse(
        404,
        'Occupancy Not Found',
        `No occupancy exists with id ${occupancyId}`,
        traceId,
      );
    }

    const updated = await updateOccupancy(
      serviceConfig,
      principal,
      occupancyId,
      existing,
      input,
      principal.sub,
      traceId,
    );
    emitOccupancyMetric('OccupancyUpdated');
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(toOccupancyResponseBody(updated)),
    };
  } catch (error) {
    logStructuredError('occupancy.update.handler_failed', traceId, {
      occupancyId,
      message: error instanceof Error ? error.message : undefined,
    });
    if (error instanceof OccupancyNotFoundError) {
      emitOccupancyMetric('OccupancyUpdated', 'NotFound');
      return toProblemResponse(
        404,
        'Occupancy Not Found',
        `No occupancy exists with id ${occupancyId}`,
        traceId,
      );
    }
    emitOccupancyMetric('OccupancyUpdated', 'Error');
    return toProblemResponse(500, 'Internal Server Error', 'Unable to update occupancy', traceId);
  }
};
