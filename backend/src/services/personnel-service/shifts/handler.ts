import { randomUUID } from 'node:crypto';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type {
  APIGatewayProxyEventV2WithLambdaAuthorizer,
  APIGatewayProxyResultV2,
  Handler,
} from 'aws-lambda';
import { buildDeptScopedPk, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import {
  createAuthzClient,
  isAuthorized as isCedarAuthorized,
  readAuthzConfig,
  AuthzUnavailableError,
} from '@boxalarm/authz';
import { emitEmf, emitOutcomeMetric } from '@boxalarm/metrics';
import type { AuthorizerContext } from '../../platform-service/authorizer/handler.js';
import { logError, logInfo } from '../lib/logger.js';
import { getDocClient, readPersonnelTableConfig } from './dynamoClient.js';
import {
  ValidationError,
  buildShiftTransactItems,
  parseCreateShiftRequest,
  parseShiftListItems,
} from './shiftAssembly.js';
import { assembleShiftCoverage, type CoverageStatus } from './coverageAssembly.js';
import {
  buildEligibleQualCodeIndex,
  fetchDeptShiftsWithPositions,
  listDeptShiftMetaItems,
  queryShiftItems,
} from './coverageRepository.js';
import { claimShiftPosition } from './claimShiftPosition.js';
import { releaseShiftPosition } from './releaseShiftPosition.js';
import {
  approveShiftSwap,
  getShiftSwapRequest,
  listPendingShiftSwaps,
  proposeShiftSwap,
} from './shiftSwap.js';
import {
  badRequestProblem,
  conflictProblem,
  notFoundProblem,
  notPendingProblem,
} from './problemDetails.js';
import { recalculateShiftStatus } from './recalculateShiftStatus.js';

type ShiftEvent = APIGatewayProxyEventV2WithLambdaAuthorizer<AuthorizerContext>;

const OFFICER_ROLES = new Set(['OFFICER', 'ADMIN', 'CHIEF']);
const METRICS_NAMESPACE = 'Boxalarm/personnel-service';

type ShiftRoute =
  | { readonly kind: 'COLLECTION' }
  | { readonly kind: 'SINGLE'; readonly shiftId: string }
  | { readonly kind: 'CLAIM'; readonly shiftId: string }
  | { readonly kind: 'RELEASE'; readonly shiftId: string }
  | { readonly kind: 'SWAP'; readonly shiftId: string }
  | { readonly kind: 'APPROVE_SWAP'; readonly shiftId: string; readonly swapId: string }
  | { readonly kind: 'SWAPS_MINE' }
  | { readonly kind: 'SWAPS_PENDING' }
  | { readonly kind: 'UNKNOWN' };

const RESERVED_SHIFT_SEGMENTS = new Set(['coverage', 'swaps']);

function parseShiftRoute(rawPath: string): ShiftRoute {
  const segments = rawPath.split('/').filter((segment) => segment.length > 0);
  const shiftsIndex = segments.indexOf('shifts');
  if (shiftsIndex === -1) {
    return { kind: 'UNKNOWN' };
  }
  const rest = segments.slice(shiftsIndex + 1);
  if (rest.length === 0) {
    return { kind: 'COLLECTION' };
  }
  if (rest.length === 2 && rest[0] === 'swaps' && rest[1] === 'mine') {
    return { kind: 'SWAPS_MINE' };
  }
  if (rest.length === 2 && rest[0] === 'swaps' && rest[1] === 'pending') {
    return { kind: 'SWAPS_PENDING' };
  }
  if (rest.length === 1 && !RESERVED_SHIFT_SEGMENTS.has(rest[0] as string)) {
    return { kind: 'SINGLE', shiftId: rest[0] as string };
  }
  if (rest.length === 2 && rest[1] === 'claim') {
    return { kind: 'CLAIM', shiftId: rest[0] as string };
  }
  if (rest.length === 2 && rest[1] === 'release') {
    return { kind: 'RELEASE', shiftId: rest[0] as string };
  }
  if (rest.length === 2 && rest[1] === 'swap') {
    return { kind: 'SWAP', shiftId: rest[0] as string };
  }
  if (rest.length === 4 && rest[1] === 'swap' && rest[3] === 'approve') {
    return { kind: 'APPROVE_SWAP', shiftId: rest[0] as string, swapId: rest[2] as string };
  }
  return { kind: 'UNKNOWN' };
}

function problemResponse(
  status: number,
  title: string,
  detail: string,
  correlationId: string,
): APIGatewayProxyResultV2 {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify({
      type: 'about:blank',
      title,
      status,
      detail,
      traceId: correlationId,
    }),
  };
}

function jsonResponse(status: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

type ShiftMetricOutcome =
  | 'ShiftCreated'
  | 'ShiftCreateFailed'
  | 'ShiftClaimed'
  | 'ShiftClaimFailed'
  | 'ShiftClaimRecalculateFailed'
  | 'ShiftReleased'
  | 'ShiftReleaseFailed'
  | 'ShiftReleaseRecalculateFailed'
  | 'ShiftSwapProposed'
  | 'ShiftSwapProposeFailed'
  | 'ShiftSwapApproved'
  | 'ShiftSwapApproveFailed';

function emitShiftMetric(outcome: ShiftMetricOutcome): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/personnel-service',
            Dimensions: [[]],
            Metrics: [{ Name: outcome, Unit: 'Count' }],
          },
        ],
      },
      [outcome]: 1,
    }),
  );
}

function hasOfficerRole(context: AuthorizerContext): boolean {
  const groups = context['cognito:groups'].split(' ').filter((group) => group.length > 0);
  return groups.some((group) => OFFICER_ROLES.has(group.toUpperCase()));
}

function extractBearerToken(event: ShiftEvent): string | undefined {
  const header = event.headers?.authorization ?? event.headers?.Authorization;
  if (!header) {
    return undefined;
  }
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : undefined;
}

type SwapApprovalDecision = 'ALLOW' | 'DENY' | 'UNAVAILABLE';

async function decideOfficerSwapApproval(
  event: ShiftEvent,
  swapId: number,
  correlationId: string,
): Promise<SwapApprovalDecision> {
  const token = extractBearerToken(event);
  if (!token) {
    return 'DENY';
  }
  try {
    const client = createAuthzClient(process.env);
    const config = readAuthzConfig(process.env);
    const allowed = await isCedarAuthorized(client, config, token, {
      actionType: 'Boxalarm::Action',
      actionId: 'ApproveShiftSwap',
      resourceType: 'Boxalarm::ShiftSwapRequest',
      resourceId: String(swapId),
    });
    return allowed ? 'ALLOW' : 'DENY';
  } catch (error) {
    if (error instanceof AuthzUnavailableError) {
      logHandlerError('shifts.swap.approve.authz_unavailable', correlationId, error);
      return 'UNAVAILABLE';
    }
    throw error;
  }
}

async function decideOfficerSwapsListAuthorized(
  event: ShiftEvent,
  deptId: VerifiedDeptId,
  correlationId: string,
): Promise<SwapApprovalDecision> {
  const token = extractBearerToken(event);
  if (!token) {
    return 'DENY';
  }
  try {
    const client = createAuthzClient(process.env);
    const config = readAuthzConfig(process.env);
    const allowed = await isCedarAuthorized(client, config, token, {
      actionType: 'Boxalarm::Action',
      actionId: 'ListPendingShiftSwaps',
      resourceType: 'Boxalarm::Department',
      resourceId: deptId,
    });
    return allowed ? 'ALLOW' : 'DENY';
  } catch (error) {
    if (error instanceof AuthzUnavailableError) {
      logHandlerError('shifts.swaps.pending.authz_unavailable', correlationId, error);
      return 'UNAVAILABLE';
    }
    throw error;
  }
}

async function memberExists(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  memberId: string,
): Promise<boolean> {
  const result = await docClient.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: buildDeptScopedPk(deptId, 'MEMBER', memberId), sk: 'METADATA' },
    }),
  );
  return result.Item !== undefined;
}

function logHandlerError(event: string, correlationId: string, error: unknown): void {
  console.error(
    JSON.stringify({
      event,
      correlationId,
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      message: error instanceof Error ? error.message : undefined,
      stack: error instanceof Error ? error.stack : undefined,
    }),
  );
}

function resolveVerifiedDeptId(
  context: AuthorizerContext,
  eventName: string,
  correlationId: string,
): VerifiedDeptId | undefined {
  try {
    return toVerifiedDeptId(context);
  } catch (error) {
    logHandlerError(eventName, correlationId, error);
    return undefined;
  }
}

async function handleCreate(
  event: ShiftEvent,
  correlationId: string,
): Promise<APIGatewayProxyResultV2> {
  const context = event.requestContext.authorizer.lambda;

  // TODO: E8-S3 — replace with Cedar IsAuthorizedWithToken
  if (!hasOfficerRole(context)) {
    return problemResponse(
      403,
      'Forbidden',
      'officer or admin role is required to create a duty shift',
      correlationId,
    );
  }

  let rawBody: unknown;
  try {
    rawBody = event.body ? (JSON.parse(event.body) as unknown) : undefined;
  } catch (error) {
    logHandlerError('shifts.create.invalid_json', correlationId, error);
    return problemResponse(400, 'Bad Request', 'body must be valid JSON', correlationId);
  }

  let input;
  try {
    input = parseCreateShiftRequest(rawBody);
  } catch (error) {
    if (error instanceof ValidationError) {
      return problemResponse(400, 'Bad Request', error.message, correlationId);
    }
    logHandlerError('shifts.create.validation_error', correlationId, error);
    return problemResponse(400, 'Bad Request', 'invalid request body', correlationId);
  }

  const deptId = resolveVerifiedDeptId(context, 'shifts.create.invalid_dept', correlationId);
  if (deptId === undefined) {
    return problemResponse(
      500,
      'Internal Server Error',
      'department context is invalid',
      correlationId,
    );
  }
  const shiftId = randomUUID();

  try {
    const { tableName } = readPersonnelTableConfig(process.env);
    const docClient = getDocClient(process.env);
    const transactItems = buildShiftTransactItems(deptId, shiftId, tableName, input);
    await docClient.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch (error) {
    logHandlerError('shifts.create.write_failed', correlationId, error);
    emitShiftMetric('ShiftCreateFailed');
    return problemResponse(503, 'Service Unavailable', 'shift could not be created', correlationId);
  }

  emitShiftMetric('ShiftCreated');
  return jsonResponse(201, {
    shiftId,
    status: 'OPEN',
    startAt: input.startAt,
    endAt: input.endAt,
    stationId: input.stationId,
    positions: input.positions,
  });
}

async function handleClaim(
  event: ShiftEvent,
  correlationId: string,
  shiftId: string,
): Promise<APIGatewayProxyResultV2> {
  const context = event.requestContext.authorizer.lambda;

  let rawBody: unknown;
  try {
    rawBody = event.body ? (JSON.parse(event.body) as unknown) : undefined;
  } catch (error) {
    logHandlerError('shifts.claim.invalid_json', correlationId, error);
    return badRequestProblem(correlationId, 'body must be valid JSON');
  }
  const body = (rawBody ?? {}) as Partial<Record<string, unknown>>;
  const positionCode = body.positionCode;
  if (typeof positionCode !== 'string' || positionCode.length === 0) {
    return badRequestProblem(
      correlationId,
      'positionCode is required and must be a non-empty string',
    );
  }

  const deptId = resolveVerifiedDeptId(context, 'shifts.claim.invalid_dept', correlationId);
  if (deptId === undefined) {
    return problemResponse(
      500,
      'Internal Server Error',
      'department context is invalid',
      correlationId,
    );
  }
  const memberId = context.sub;

  let tableName: string;
  let docClient: DynamoDBDocumentClient;
  let outcome;
  try {
    ({ tableName } = readPersonnelTableConfig(process.env));
    docClient = getDocClient(process.env);
    outcome = await claimShiftPosition(
      docClient,
      tableName,
      deptId,
      shiftId,
      positionCode,
      memberId,
    );
  } catch (error) {
    logHandlerError('shifts.claim.write_failed', correlationId, error);
    emitShiftMetric('ShiftClaimFailed');
    return problemResponse(
      503,
      'Service Unavailable',
      'shift position could not be claimed',
      correlationId,
    );
  }

  if (outcome.kind === 'NOT_FOUND') {
    emitShiftMetric('ShiftClaimFailed');
    return notFoundProblem(correlationId);
  }
  if (outcome.kind === 'CONFLICT') {
    emitShiftMetric('ShiftClaimFailed');
    return conflictProblem(correlationId);
  }

  try {
    await recalculateShiftStatus(docClient, tableName, deptId, shiftId);
  } catch (error) {
    logHandlerError('shifts.claim.recalculate_failed', correlationId, error);
    emitShiftMetric('ShiftClaimRecalculateFailed');
  }

  emitShiftMetric('ShiftClaimed');
  return jsonResponse(outcome.kind === 'ALREADY_MINE' ? 200 : 201, {
    shiftId,
    positionCode,
    claimedByMemberId: memberId,
    claimedAt: outcome.claimedAt,
  });
}

async function handleGetShift(
  event: ShiftEvent,
  correlationId: string,
  shiftId: string,
): Promise<APIGatewayProxyResultV2> {
  const context = event.requestContext.authorizer.lambda;
  const deptId = resolveVerifiedDeptId(context, 'shifts.get.invalid_dept', correlationId);
  if (deptId === undefined) {
    return problemResponse(
      500,
      'Internal Server Error',
      'department context is invalid',
      correlationId,
    );
  }
  const memberId = context.sub;

  try {
    const { tableName } = readPersonnelTableConfig(process.env);
    const docClient = getDocClient(process.env);
    const items = await queryShiftItems(
      docClient,
      tableName,
      buildDeptScopedPk(deptId, 'SHIFT', shiftId),
    );
    const metadata = items.find((item) => item.sk === 'METADATA');
    if (metadata === undefined) {
      return notFoundProblem(correlationId);
    }
    const positions = items
      .filter((item) => typeof item.sk === 'string' && item.sk.startsWith('POSITION#'))
      .map((item) => ({
        positionCode: String(item.positionCode),
        ...(item.requiredQual !== undefined ? { requiredQual: item.requiredQual as string } : {}),
        ...(item.claimedByMemberId !== undefined
          ? {
              claimedByMemberId: item.claimedByMemberId as string,
              claimedByMe: item.claimedByMemberId === memberId,
            }
          : {}),
      }));
    return jsonResponse(200, {
      shiftId,
      startAt: Number(metadata.startAt),
      endAt: Number(metadata.endAt),
      stationId: String(metadata.stationId),
      status: String(metadata.status),
      positions,
    });
  } catch (error) {
    logHandlerError('shifts.get.query_failed', correlationId, error);
    return problemResponse(
      503,
      'Service Unavailable',
      'shift could not be retrieved',
      correlationId,
    );
  }
}

async function handleListMySwaps(
  event: ShiftEvent,
  correlationId: string,
): Promise<APIGatewayProxyResultV2> {
  const context = event.requestContext.authorizer.lambda;
  const deptId = resolveVerifiedDeptId(context, 'shifts.swaps.mine.invalid_dept', correlationId);
  if (deptId === undefined) {
    return problemResponse(
      500,
      'Internal Server Error',
      'department context is invalid',
      correlationId,
    );
  }
  const memberId = context.sub;

  try {
    const { tableName } = readPersonnelTableConfig(process.env);
    const docClient = getDocClient(process.env);
    const swaps = await listPendingShiftSwaps(docClient, tableName, deptId);
    const mine = swaps.filter(
      (swap) => swap.fromMemberId === memberId || swap.toMemberId === memberId,
    );
    return jsonResponse(200, { swaps: mine });
  } catch (error) {
    logHandlerError('shifts.swaps.mine.query_failed', correlationId, error);
    return problemResponse(
      503,
      'Service Unavailable',
      'pending shift swaps could not be listed',
      correlationId,
    );
  }
}

async function handleListPendingSwaps(
  event: ShiftEvent,
  correlationId: string,
): Promise<APIGatewayProxyResultV2> {
  const context = event.requestContext.authorizer.lambda;
  const deptId = resolveVerifiedDeptId(context, 'shifts.swaps.pending.invalid_dept', correlationId);
  if (deptId === undefined) {
    return problemResponse(
      500,
      'Internal Server Error',
      'department context is invalid',
      correlationId,
    );
  }

  const decision = await decideOfficerSwapsListAuthorized(event, deptId, correlationId);
  if (decision === 'UNAVAILABLE') {
    return problemResponse(
      503,
      'Service Unavailable',
      'authorization could not be determined',
      correlationId,
    );
  }
  if (decision === 'DENY') {
    return problemResponse(
      403,
      'Forbidden',
      'officer or admin role is required to view pending shift swaps',
      correlationId,
    );
  }

  try {
    const { tableName } = readPersonnelTableConfig(process.env);
    const docClient = getDocClient(process.env);
    const swaps = await listPendingShiftSwaps(docClient, tableName, deptId);
    return jsonResponse(200, { swaps: swaps.filter((swap) => swap.requiresOfficerApproval) });
  } catch (error) {
    logHandlerError('shifts.swaps.pending.query_failed', correlationId, error);
    return problemResponse(
      503,
      'Service Unavailable',
      'pending shift swaps could not be listed',
      correlationId,
    );
  }
}

async function handleRelease(
  event: ShiftEvent,
  correlationId: string,
  shiftId: string,
): Promise<APIGatewayProxyResultV2> {
  const context = event.requestContext.authorizer.lambda;

  let rawBody: unknown;
  try {
    rawBody = event.body ? (JSON.parse(event.body) as unknown) : undefined;
  } catch (error) {
    logHandlerError('shifts.release.invalid_json', correlationId, error);
    return badRequestProblem(correlationId, 'body must be valid JSON');
  }
  const body = (rawBody ?? {}) as Partial<Record<string, unknown>>;
  const positionCode = body.positionCode;
  if (typeof positionCode !== 'string' || positionCode.length === 0) {
    return badRequestProblem(
      correlationId,
      'positionCode is required and must be a non-empty string',
    );
  }

  const deptId = resolveVerifiedDeptId(context, 'shifts.release.invalid_dept', correlationId);
  if (deptId === undefined) {
    return problemResponse(
      500,
      'Internal Server Error',
      'department context is invalid',
      correlationId,
    );
  }
  const memberId = context.sub;
  let tableName: string;
  let docClient: DynamoDBDocumentClient;

  try {
    ({ tableName } = readPersonnelTableConfig(process.env));
    docClient = getDocClient(process.env);
    const outcome = await releaseShiftPosition(
      docClient,
      tableName,
      deptId,
      shiftId,
      positionCode,
      memberId,
    );
    if (outcome.kind === 'NOT_FOUND') {
      emitShiftMetric('ShiftReleaseFailed');
      return notFoundProblem(correlationId);
    }
    if (outcome.kind === 'NOT_CLAIMED_BY_YOU') {
      emitShiftMetric('ShiftReleaseFailed');
      return conflictProblem(correlationId);
    }
  } catch (error) {
    logHandlerError('shifts.release.write_failed', correlationId, error);
    emitShiftMetric('ShiftReleaseFailed');
    return problemResponse(
      503,
      'Service Unavailable',
      'shift position could not be released',
      correlationId,
    );
  }

  try {
    await recalculateShiftStatus(docClient, tableName, deptId, shiftId);
  } catch (error) {
    logHandlerError('shifts.release.recalculate_failed', correlationId, error);
    emitShiftMetric('ShiftReleaseRecalculateFailed');
  }

  emitShiftMetric('ShiftReleased');
  return jsonResponse(200, { shiftId, positionCode, released: true });
}

async function handleSwap(
  event: ShiftEvent,
  correlationId: string,
  shiftId: string,
): Promise<APIGatewayProxyResultV2> {
  const context = event.requestContext.authorizer.lambda;

  let rawBody: unknown;
  try {
    rawBody = event.body ? (JSON.parse(event.body) as unknown) : undefined;
  } catch (error) {
    logHandlerError('shifts.swap.invalid_json', correlationId, error);
    return badRequestProblem(correlationId, 'body must be valid JSON');
  }
  const body = (rawBody ?? {}) as Partial<Record<string, unknown>>;
  const positionCode = body.positionCode;
  const toMemberId = body.toMemberId;
  if (typeof positionCode !== 'string' || positionCode.length === 0) {
    return badRequestProblem(
      correlationId,
      'positionCode is required and must be a non-empty string',
    );
  }
  if (typeof toMemberId !== 'string' || toMemberId.length === 0) {
    return badRequestProblem(
      correlationId,
      'toMemberId is required and must be a non-empty string',
    );
  }

  const deptId = resolveVerifiedDeptId(context, 'shifts.swap.invalid_dept', correlationId);
  if (deptId === undefined) {
    return problemResponse(
      500,
      'Internal Server Error',
      'department context is invalid',
      correlationId,
    );
  }
  const fromMemberId = context.sub;
  if (toMemberId === fromMemberId) {
    return badRequestProblem(
      correlationId,
      'toMemberId must be a different member than the caller',
    );
  }

  try {
    const { tableName } = readPersonnelTableConfig(process.env);
    const docClient = getDocClient(process.env);
    if (!(await memberExists(docClient, tableName, deptId, toMemberId))) {
      emitShiftMetric('ShiftSwapProposeFailed');
      return notFoundProblem(correlationId);
    }
    const outcome = await proposeShiftSwap(
      docClient,
      tableName,
      deptId,
      shiftId,
      positionCode,
      fromMemberId,
      toMemberId,
    );
    if (outcome.kind === 'POSITION_NOT_FOUND') {
      emitShiftMetric('ShiftSwapProposeFailed');
      return notFoundProblem(correlationId);
    }
    if (outcome.kind === 'NOT_CLAIMED_BY_YOU') {
      emitShiftMetric('ShiftSwapProposeFailed');
      return conflictProblem(correlationId);
    }
    emitShiftMetric('ShiftSwapProposed');
    return jsonResponse(201, {
      shiftId,
      swapId: outcome.requestedAt,
      positionCode,
      fromMemberId,
      toMemberId,
      status: 'PENDING',
      requiresOfficerApproval: outcome.requiresOfficerApproval,
    });
  } catch (error) {
    logHandlerError('shifts.swap.write_failed', correlationId, error);
    emitShiftMetric('ShiftSwapProposeFailed');
    return problemResponse(
      503,
      'Service Unavailable',
      'shift swap could not be proposed',
      correlationId,
    );
  }
}

async function handleApproveSwap(
  event: ShiftEvent,
  correlationId: string,
  shiftId: string,
  swapIdRaw: string,
): Promise<APIGatewayProxyResultV2> {
  const context = event.requestContext.authorizer.lambda;
  const swapId = Number(swapIdRaw);
  if (!Number.isFinite(swapId)) {
    return badRequestProblem(correlationId, 'swapId path parameter must be a numeric epoch value');
  }

  const deptId = resolveVerifiedDeptId(context, 'shifts.swap.approve.invalid_dept', correlationId);
  if (deptId === undefined) {
    return problemResponse(
      500,
      'Internal Server Error',
      'department context is invalid',
      correlationId,
    );
  }

  try {
    const { tableName } = readPersonnelTableConfig(process.env);
    const docClient = getDocClient(process.env);

    const swap = await getShiftSwapRequest(docClient, tableName, deptId, shiftId, swapId);
    if (swap === undefined) {
      emitShiftMetric('ShiftSwapApproveFailed');
      return notFoundProblem(correlationId);
    }

    if (swap.requiresOfficerApproval) {
      const decision = await decideOfficerSwapApproval(event, swapId, correlationId);
      if (decision === 'UNAVAILABLE') {
        emitShiftMetric('ShiftSwapApproveFailed');
        return problemResponse(
          503,
          'Service Unavailable',
          'authorization could not be determined',
          correlationId,
        );
      }
      if (decision === 'DENY') {
        emitShiftMetric('ShiftSwapApproveFailed');
        return problemResponse(
          403,
          'Forbidden',
          'officer or admin role is required to approve this swap',
          correlationId,
        );
      }
    } else if (context.sub !== swap.toMemberId) {
      emitShiftMetric('ShiftSwapApproveFailed');
      return problemResponse(
        403,
        'Forbidden',
        'only the target member can accept this swap',
        correlationId,
      );
    }

    const outcome = await approveShiftSwap(docClient, tableName, deptId, shiftId, swapId);
    if (outcome.kind === 'NOT_FOUND') {
      emitShiftMetric('ShiftSwapApproveFailed');
      return notFoundProblem(correlationId);
    }
    if (outcome.kind === 'NOT_PENDING') {
      emitShiftMetric('ShiftSwapApproveFailed');
      return notPendingProblem(correlationId);
    }
    if (outcome.kind === 'POSITION_CONFLICT') {
      emitShiftMetric('ShiftSwapApproveFailed');
      return conflictProblem(correlationId);
    }
    emitShiftMetric('ShiftSwapApproved');
    return jsonResponse(200, {
      shiftId,
      swapId,
      status: 'APPROVED',
      claimedByMemberId: outcome.toMemberId,
    });
  } catch (error) {
    logHandlerError('shifts.swap.approve.write_failed', correlationId, error);
    emitShiftMetric('ShiftSwapApproveFailed');
    return problemResponse(503, 'Service Unavailable', 'swap could not be approved', correlationId);
  }
}

async function handleList(
  event: ShiftEvent,
  correlationId: string,
): Promise<APIGatewayProxyResultV2> {
  const context = event.requestContext.authorizer.lambda;
  const deptId = resolveVerifiedDeptId(context, 'shifts.list.invalid_dept', correlationId);
  if (deptId === undefined) {
    return problemResponse(
      500,
      'Internal Server Error',
      'department context is invalid',
      correlationId,
    );
  }

  try {
    const { tableName } = readPersonnelTableConfig(process.env);
    const docClient = getDocClient(process.env);
    const rawItems = await listDeptShiftMetaItems(docClient, tableName, deptId);
    const shifts = parseShiftListItems(rawItems);
    return jsonResponse(200, { shifts });
  } catch (error) {
    logHandlerError('shifts.list.query_failed', correlationId, error);
    return problemResponse(503, 'Service Unavailable', 'shifts could not be listed', correlationId);
  }
}

async function handleCoverage(
  event: ShiftEvent,
  correlationId: string,
): Promise<APIGatewayProxyResultV2> {
  const context = event.requestContext.authorizer.lambda;

  // TODO: E8-S3 — replace with Cedar IsAuthorizedWithToken
  if (!hasOfficerRole(context)) {
    return problemResponse(
      403,
      'Forbidden',
      'officer or admin role is required to view shift coverage',
      correlationId,
    );
  }

  const deptId = resolveVerifiedDeptId(context, 'shifts.coverage.invalid_dept', correlationId);
  if (deptId === undefined) {
    return problemResponse(
      500,
      'Internal Server Error',
      'department context is invalid',
      correlationId,
    );
  }

  try {
    const { tableName } = readPersonnelTableConfig(process.env);
    const docClient = getDocClient(process.env);
    const shifts = await fetchDeptShiftsWithPositions(docClient, tableName, deptId);
    const eligibleQualCodes = await buildEligibleQualCodeIndex(
      docClient,
      tableName,
      deptId,
      correlationId,
    );
    const coverage = shifts.map((shift) => assembleShiftCoverage(shift, eligibleQualCodes));
    const counts = coverage.reduce(
      (acc, shift) => {
        acc[shift.status] += 1;
        return acc;
      },
      { covered: 0, short: 0, 'qual-gapped': 0 } as Record<CoverageStatus, number>,
    );
    emitEmf(METRICS_NAMESPACE, 'ShiftCoverageCovered', counts.covered, [[]]);
    emitEmf(METRICS_NAMESPACE, 'ShiftCoverageShort', counts.short, [[]]);
    emitEmf(METRICS_NAMESPACE, 'ShiftCoverageQualGapped', counts['qual-gapped'], [[]]);
    logInfo('shifts.coverage.read', correlationId, { deptId, shiftCount: coverage.length });
    return jsonResponse(200, { shifts: coverage });
  } catch (error) {
    logError('shifts.coverage.query_failed', correlationId, error);
    emitOutcomeMetric(METRICS_NAMESPACE, 'ShiftCoverageQueryFailed');
    return problemResponse(
      503,
      'Service Unavailable',
      'shift coverage could not be computed',
      correlationId,
    );
  }
}

export const handler: Handler<ShiftEvent, APIGatewayProxyResultV2> = async (event) => {
  const correlationId = event.requestContext.requestId;
  const method = event.requestContext.http.method;
  const route = parseShiftRoute(event.rawPath);

  if (method === 'POST' && route.kind === 'RELEASE') {
    return handleRelease(event, correlationId, route.shiftId);
  }
  if (method === 'POST' && route.kind === 'CLAIM') {
    return handleClaim(event, correlationId, route.shiftId);
  }
  if (method === 'POST' && route.kind === 'SWAP') {
    return handleSwap(event, correlationId, route.shiftId);
  }
  if (method === 'POST' && route.kind === 'APPROVE_SWAP') {
    return handleApproveSwap(event, correlationId, route.shiftId, route.swapId);
  }
  if (method === 'POST' && route.kind === 'COLLECTION') {
    return handleCreate(event, correlationId);
  }
  if (method === 'GET') {
    if (event.requestContext.http.path.endsWith('/coverage')) {
      return handleCoverage(event, correlationId);
    }
    if (route.kind === 'SWAPS_MINE') {
      return handleListMySwaps(event, correlationId);
    }
    if (route.kind === 'SWAPS_PENDING') {
      return handleListPendingSwaps(event, correlationId);
    }
    if (route.kind === 'COLLECTION') {
      return handleList(event, correlationId);
    }
    if (route.kind === 'SINGLE') {
      return handleGetShift(event, correlationId, route.shiftId);
    }
  }
  return problemResponse(
    405,
    'Method Not Allowed',
    `${method} is not supported on this route`,
    correlationId,
  );
};
