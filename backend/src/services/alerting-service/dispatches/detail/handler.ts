import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  badRequestProblem,
  extractTraceId,
  notFoundProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { assertNoDelimiter, toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { createDynamoClient, readAlertingConfig } from '../../eligibility/dynamoClient.js';
import { logError } from '../logger.js';
import { toMutualAidView, type MutualAidView } from '../../ladderControls/shared.js';
import { getDispatchDetail, getMutualAidEvent, type DispatchAlertItem } from './repository.js';
import { buildMapLink } from './mapLink.js';
import { dataUnavailableProblem } from './problemDetails.js';
import {
  findNearestHydrants,
  findPrePlanByAddress,
  findPrePlanNear,
  type PrePlanCopyItem,
  type UtilityShutoff,
} from '../../prePlan/prePlanCopyRepository.js';
import { isGeoPoint, type GeoPoint } from '../../prePlan/geo.js';
import type { NearestHydrant } from '../../prePlan/nearestHydrants.js';

const METRICS_NAMESPACE = 'Boxalarm/Alerting';

/** The `prePlan` block of the detail response (web + mobile PrePlanPanel). */
interface PrePlanView {
  readonly summary?: string;
  readonly hazards: readonly string[];
  readonly utilityShutoffs: readonly UtilityShutoff[];
  readonly nearestHydrants: readonly NearestHydrant[];
}

async function matchPrePlan(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  item: DispatchAlertItem,
  dispatchPoint: GeoPoint | undefined,
): Promise<PrePlanCopyItem | undefined> {
  const byAddress = item.address
    ? await findPrePlanByAddress(client, tableName, deptId, item.address, dispatchPoint)
    : undefined;
  if (byAddress || !dispatchPoint) {
    return byAddress;
  }
  return findPrePlanNear(client, tableName, deptId, dispatchPoint);
}

/**
 * Pre-plan + hydrant context for the dispatch: the PRE_PLAN_COPY whose occupancy matches the
 * dispatch (normalized street address, else within 50 m of the dispatch's own coordinates
 * when CAD supplies them), and the nearest usable hydrants to that occupancy (or to the
 * dispatch point when the occupancy has no coordinates).
 *
 * Read-side enrichment only — it runs after the page went out and reads nothing but the
 * alerting table's copies. Any failure degrades to prePlan: null (or, if only the hydrant read
 * fails, an empty hydrant list); it never fails the dispatch detail.
 */
async function fetchPrePlan(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  item: DispatchAlertItem,
  traceId: string,
): Promise<PrePlanView | null> {
  const dispatchLocation = { latitude: item.latitude, longitude: item.longitude };
  const dispatchPoint = isGeoPoint(dispatchLocation) ? dispatchLocation : undefined;

  let copy: PrePlanCopyItem | undefined;
  try {
    copy = await matchPrePlan(client, tableName, deptId, item, dispatchPoint);
  } catch (error) {
    logError('dispatches.detail.preplan_read_failed', error, {
      traceId,
      dispatchId: item.dispatchId,
    });
    return null;
  }
  if (!copy) {
    emitOutcomeMetric(METRICS_NAMESPACE, 'AlertDetailPrePlanNoMatch');
    return null;
  }

  const occupancyLocation = { latitude: copy.latitude, longitude: copy.longitude };
  const hydrantReference = isGeoPoint(occupancyLocation) ? occupancyLocation : dispatchPoint;
  let nearestHydrants: readonly NearestHydrant[] = [];
  if (hydrantReference) {
    try {
      nearestHydrants = await findNearestHydrants(client, tableName, deptId, hydrantReference);
    } catch (error) {
      logError('dispatches.detail.hydrant_read_failed', error, {
        traceId,
        dispatchId: item.dispatchId,
      });
    }
  }
  emitOutcomeMetric(METRICS_NAMESPACE, 'AlertDetailPrePlanMatched');
  return {
    ...(copy.summary ? { summary: copy.summary } : {}),
    hazards: copy.hazards ?? [],
    utilityShutoffs: copy.utilityShutoffs ?? [],
    nearestHydrants,
  };
}

const UNAVAILABLE = Symbol('unavailable');

// The officer ladder controls (F1.13) need to know whether mutual aid is already requested
// or acknowledged. Like the pre-plan, this is enrichment: a failed read must not take the
// alert's core content (address, narrative) down with it, and must not be reported as "not
// requested" either.
async function fetchMutualAid(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  dispatchId: string,
  traceId: string,
): Promise<MutualAidView | null | typeof UNAVAILABLE> {
  try {
    const item = await getMutualAidEvent(client, tableName, deptId, dispatchId);
    return item ? toMutualAidView(item) : null;
  } catch (error) {
    logError('dispatches.detail.mutual_aid_read_failed', error, { traceId, dispatchId });
    return UNAVAILABLE;
  }
}

async function handleGetAlertDetail(
  event: GuardEvent,
  principal: CedarPrincipalContext,
  docClient?: DynamoDBDocumentClient,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const dispatchId = event.pathParameters?.dispatchId;
  if (!dispatchId) {
    return badRequestProblem(traceId, 'dispatchId path parameter is required');
  }
  try {
    assertNoDelimiter(dispatchId, 'dispatchId');
  } catch {
    return badRequestProblem(traceId, 'dispatchId path parameter must not contain "#"');
  }

  try {
    const deptId = toVerifiedDeptId(principal);
    const config = readAlertingConfig(process.env);
    const doc = createDynamoClient(process.env, docClient);

    const item = await getDispatchDetail(doc, config.tableName, deptId, dispatchId);
    if (!item) {
      emitOutcomeMetric(METRICS_NAMESPACE, 'AlertDetailViewFailed', 'NotFound');
      return notFoundProblem(traceId, `No dispatch alert found for dispatchId "${dispatchId}"`);
    }

    const [prePlan, mutualAid] = await Promise.all([
      fetchPrePlan(doc, config.tableName, deptId, item, traceId),
      fetchMutualAid(doc, config.tableName, deptId, dispatchId, traceId),
    ]);

    emitOutcomeMetric(METRICS_NAMESPACE, 'AlertDetailViewed');
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dispatchId: item.dispatchId,
        incidentType: item.incidentType,
        address: item.address,
        crossStreets: item.crossStreets,
        mapLink: item.mapLink ?? buildMapLink(item),
        narrative: item.narrative,
        eligibleMemberCount: item.eligibleMemberCount ?? null,
        fanOutStartedAt: item.fanOutStartedAt ?? null,
        toneLadder: {
          status: item.toneLadderStatus ?? 'ACTIVE',
          currentToneSequence: item.currentToneSequence ?? 1,
          nextToneAt: item.nextToneAt ?? null,
        },
        // null = not requested; the key is omitted when the read failed, so an officer's
        // screen shows "unknown" rather than "not requested" (see fetchMutualAid).
        ...(mutualAid === UNAVAILABLE ? {} : { mutualAid }),
        prePlan,
      }),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.constructor.name : 'UnknownError';
    logError('dispatches.detail.read_failed', error, {
      traceId,
      dispatchId,
      deptId: principal.deptId,
    });
    emitOutcomeMetric(METRICS_NAMESPACE, 'AlertDetailViewFailed', reason);
    return dataUnavailableProblem(traceId);
  }
}

export interface AlertDetailHandlerDeps {
  readonly authzClient?: VerifiedPermissionsClient;
  readonly docClient?: DynamoDBDocumentClient;
}

export function createHandler(
  deps: AlertDetailHandlerDeps = {},
): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  return withAuthorization(
    (event, principal) => handleGetAlertDetail(event, principal, deps.docClient),
    {
      actionType: 'Boxalarm::Action',
      actionId: 'ViewAlertDetail',
      resourceType: 'Boxalarm::Department',
      resourceId: (event) =>
        toVerifiedDeptId({ deptId: event.requestContext.authorizer.lambda?.deptId ?? '' }),
      ...(deps.authzClient ? { client: deps.authzClient } : {}),
    },
  );
}

export const handler = createHandler();
