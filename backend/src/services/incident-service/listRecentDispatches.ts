import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import { withAuthorization, type CedarPrincipalContext, type GuardEvent } from '@boxalarm/authz';
import { buildDeptScopedPk, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitIncidentMetric, problemResponse, resolveTraceId } from './authContext.js';
import {
  getReportsForDispatches,
  queryRecentDispatchCopies,
  type RecentDispatch,
} from './dispatchProjection.js';
import { getDocumentClient, getTableName } from './repository.js';

/**
 * GET /api/v1/incidents/dispatches[?cursor=&limit=] — the department's dispatches to start a
 * report from, newest first, each with the report already started from it (if any).
 *
 * The first page is every dispatch of the last 72 hours (volunteers write the report later,
 * after the alerting plane's active window has closed). `nextCursor` then pages back through
 * older dispatches, `limit` at a time. Reads incident-service's own copies of the dispatches
 * (dispatch.alert.received -> dispatchAlertConsumer.ts), never the alerting table.
 */

export const RECENT_WINDOW_HOURS = 72;
const RECENT_WINDOW_SECONDS = RECENT_WINDOW_HOURS * 3600;
/** A 72-hour window is a handful of calls for a volunteer department; this bounds a busy one. */
const RECENT_PAGE_CAP = 200;
const DEFAULT_OLDER_LIMIT = 25;
const MAX_LIMIT = 100;

interface Cursor {
  /** Upper bound (inclusive) of the range, epoch seconds. */
  readonly to: number;
  /** Lower bound (inclusive), epoch seconds. */
  readonly from: number;
  readonly lek?: Record<string, string>;
}

class BadRequest extends Error {}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/** A cursor is client-held: every field is re-validated, and its key must be this department's. */
function decodeCursor(raw: string, deptId: VerifiedDeptId): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequest('cursor is not a cursor this endpoint issued');
  }
  const value = parsed as Partial<Cursor>;
  const isSeconds = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0;
  if (!isSeconds(value.to) || !isSeconds(value.from) || value.from > value.to) {
    throw new BadRequest('cursor is not a cursor this endpoint issued');
  }
  if (value.lek !== undefined) {
    const lek = value.lek as Record<string, unknown>;
    const keys = ['pk', 'sk', 'gsi1pk', 'gsi1sk'];
    const wellFormed =
      typeof lek === 'object' &&
      lek !== null &&
      Object.keys(lek).every((k) => keys.includes(k)) &&
      keys.every((k) => typeof lek[k] === 'string') &&
      lek.gsi1pk === buildDeptScopedPk(deptId);
    if (!wellFormed) throw new BadRequest('cursor is not a cursor this endpoint issued');
  }
  return value as Cursor;
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_OLDER_LIMIT;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new BadRequest(`limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return limit;
}

interface Deps {
  readonly client: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly nowSeconds: () => number;
}

async function listRecentDispatches(
  event: GuardEvent,
  principal: CedarPrincipalContext,
  deps: Deps,
): Promise<APIGatewayProxyResultV2> {
  const traceId = resolveTraceId(event.headers, event.requestContext.requestId);
  const deptId = toVerifiedDeptId(principal);
  const params = event.queryStringParameters ?? {};

  let cursor: Cursor | undefined;
  let limit: number;
  try {
    cursor = params.cursor ? decodeCursor(params.cursor, deptId) : undefined;
    limit = parseLimit(params.limit);
  } catch (error) {
    if (error instanceof BadRequest) {
      return problemResponse(400, 'Bad Request', error.message, traceId);
    }
    throw error;
  }

  const now = deps.nowSeconds();
  const windowStart = now - RECENT_WINDOW_SECONDS;
  try {
    let dispatches: RecentDispatch[] = [];
    let nextCursor: Cursor | null;
    if (!cursor) {
      // The whole 72-hour window, paged through internally up to the cap.
      let lek: Record<string, unknown> | undefined;
      do {
        const page = await queryRecentDispatchCopies(deps.client, deps.tableName, deptId, {
          fromSeconds: windowStart,
          toSeconds: now,
          limit: RECENT_PAGE_CAP - dispatches.length,
          ...(lek ? { exclusiveStartKey: lek } : {}),
        });
        dispatches = [...dispatches, ...page.dispatches];
        lek = page.lastEvaluatedKey;
      } while (lek && dispatches.length < RECENT_PAGE_CAP);
      nextCursor = lek
        ? { from: windowStart, to: now, lek: lek as Record<string, string> }
        : windowStart > 0
          ? { from: 0, to: windowStart - 1 }
          : null;
    } else {
      const page = await queryRecentDispatchCopies(deps.client, deps.tableName, deptId, {
        fromSeconds: cursor.from,
        toSeconds: cursor.to,
        limit,
        ...(cursor.lek ? { exclusiveStartKey: cursor.lek } : {}),
      });
      dispatches = [...page.dispatches];
      nextCursor = page.lastEvaluatedKey
        ? { ...cursor, lek: page.lastEvaluatedKey as Record<string, string> }
        : // The truncated 72-hour page hands over to the older range once it is read out.
          cursor.from > 0
          ? { from: 0, to: cursor.from - 1 }
          : null;
    }

    const reports = await getReportsForDispatches(
      deps.client,
      deps.tableName,
      deptId,
      dispatches.map((d) => d.dispatchId),
    );
    emitIncidentMetric('RecentDispatchesListed');
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recentWindowHours: RECENT_WINDOW_HOURS,
        dispatches: dispatches.map((dispatch) => ({
          ...dispatch,
          report: reports.get(dispatch.dispatchId) ?? null,
        })),
        nextCursor: nextCursor ? encodeCursor(nextCursor) : null,
      }),
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'incident.recentDispatches.failed',
        correlationId: traceId,
        deptId,
        message: error instanceof Error ? error.message : undefined,
        stack: error instanceof Error ? error.stack : undefined,
      }),
    );
    emitIncidentMetric('RecentDispatchesFailed');
    return problemResponse(503, 'Service Unavailable', 'Unable to list dispatches.', traceId);
  }
}

interface Overrides {
  readonly client?: DynamoDBDocumentClient;
  readonly tableName?: string;
  readonly nowSeconds?: () => number;
  readonly authzClient?: VerifiedPermissionsClient;
}

export function createListRecentDispatchesHandler(
  overrides: Overrides = {},
): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  return withAuthorization(
    (event, principal) =>
      listRecentDispatches(event, principal, {
        client: overrides.client ?? getDocumentClient(),
        tableName: overrides.tableName ?? getTableName(process.env),
        nowSeconds: overrides.nowSeconds ?? (() => Math.floor(Date.now() / 1000)),
      }),
    {
      actionType: 'Boxalarm::Action',
      actionId: 'ListRecentDispatches',
      resourceType: 'Boxalarm::Department',
      resourceId: (event) => event.requestContext.authorizer?.lambda?.deptId ?? '',
      ...(overrides.authzClient !== undefined ? { client: overrides.authzClient } : {}),
    },
  );
}

export const handler = createListRecentDispatchesHandler();
