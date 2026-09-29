import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { logError } from '../logger.js';
import type { DispatchAlertItem } from './repository.js';
import { normalizeAddress } from '../../prePlan/addressKey.js';
import { isGeoPoint, type GeoPoint } from '../../prePlan/geo.js';
import type { NearestHydrant } from '../../prePlan/nearestHydrants.js';
import {
  findNearestHydrants,
  findPrePlanByAddress,
  findPrePlanNear,
  type PrePlanCandidate,
  type PrePlanCopyItem,
  type PrePlanMatch,
  type PrePlanMatchType,
  type UtilityShutoff,
} from '../../prePlan/prePlanCopyRepository.js';

const METRICS_NAMESPACE = 'Boxalarm/Alerting';

/** The pre-plan lookup itself failed — distinct from "no pre-plan matched" (null). */
export const PRE_PLAN_UNAVAILABLE = Symbol('prePlanUnavailable');

/** One pre-plan among several the crew must choose between (matchType CANDIDATES). */
interface PrePlanCandidateView {
  readonly occupancyId: string;
  readonly matchedAddress: string;
  readonly unit: string | null;
  readonly summary?: string;
  readonly hazards: readonly string[];
  readonly utilityShutoffs: readonly UtilityShutoff[];
  readonly distanceMeters?: number;
}

/**
 * The `prePlan` block of the detail response (web + mobile PrePlanPanel). It always says what
 * was matched and how: matchType + matchedAddress (+ distanceMeters for NEARBY), so a crew is
 * never shown a guess as if it were this building's plan. For CANDIDATES the top-level
 * hazards/utilityShutoffs are empty and each candidate carries its own.
 */
export interface PrePlanView {
  readonly matchType: PrePlanMatchType;
  readonly matchedAddress: string;
  readonly unit: string | null;
  readonly distanceMeters?: number;
  readonly summary?: string;
  readonly hazards: readonly string[];
  readonly utilityShutoffs: readonly UtilityShutoff[];
  readonly nearestHydrants: readonly NearestHydrant[];
  readonly candidates?: readonly PrePlanCandidateView[];
}

function addressOf(copy: PrePlanCopyItem): string {
  return copy.address ?? `occupancy ${copy.occupancyId}`;
}

function candidateView({ copy, distanceMeters }: PrePlanCandidate): PrePlanCandidateView {
  return {
    occupancyId: copy.occupancyId,
    matchedAddress: addressOf(copy),
    unit: copy.addressUnit ?? null,
    ...(copy.summary ? { summary: copy.summary } : {}),
    hazards: copy.hazards ?? [],
    utilityShutoffs: copy.utilityShutoffs ?? [],
    ...(distanceMeters !== undefined ? { distanceMeters } : {}),
  };
}

function pointOf(copy: PrePlanCopyItem): GeoPoint | undefined {
  const location = { latitude: copy.latitude, longitude: copy.longitude };
  return isGeoPoint(location) ? location : undefined;
}

/**
 * Address first. The geo fallback runs only for a dispatch with no usable street address
 * (CAD coordinates, no house number/street): an address that simply has no pre-plan must show
 * none, not the neighbour's.
 */
async function matchPrePlan(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  item: DispatchAlertItem,
  dispatchPoint: GeoPoint | undefined,
): Promise<PrePlanMatch | undefined> {
  if (item.address && normalizeAddress(item.address)) {
    return findPrePlanByAddress(client, tableName, deptId, item.address, dispatchPoint);
  }
  return dispatchPoint ? findPrePlanNear(client, tableName, deptId, dispatchPoint) : undefined;
}

/**
 * Pre-plan + hydrant context for the dispatch. Read-side enrichment only — it runs after the
 * page went out and reads nothing but the alerting table's copies. A failed lookup is reported
 * as PRE_PLAN_UNAVAILABLE (the response then says prePlanUnavailable, never "no pre-plan");
 * a failed hydrant read leaves an empty hydrant list; neither fails the dispatch detail.
 */
export async function fetchPrePlan(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  item: DispatchAlertItem,
  traceId: string,
): Promise<PrePlanView | null | typeof PRE_PLAN_UNAVAILABLE> {
  const dispatchLocation = { latitude: item.latitude, longitude: item.longitude };
  const dispatchPoint = isGeoPoint(dispatchLocation) ? dispatchLocation : undefined;

  let match: PrePlanMatch | undefined;
  try {
    match = await matchPrePlan(client, tableName, deptId, item, dispatchPoint);
  } catch (error) {
    logError('dispatches.detail.preplan_read_failed', error, {
      traceId,
      dispatchId: item.dispatchId,
    });
    emitOutcomeMetric(METRICS_NAMESPACE, 'AlertDetailPrePlanUnavailable');
    // Never reported as "no pre-plan": a throttle must not tell a crew the building has none.
    return PRE_PLAN_UNAVAILABLE;
  }
  if (!match) {
    emitOutcomeMetric(METRICS_NAMESPACE, 'AlertDetailPrePlanNoMatch');
    return null;
  }
  emitOutcomeMetric(METRICS_NAMESPACE, 'AlertDetailPrePlanMatched', match.matchType);

  const primary = match.matchType === 'CANDIDATES' ? match.candidates[0]?.copy : match.copy;
  // NEARBY: the dispatch point is the truth; otherwise the matched building's own location.
  const hydrantReference =
    match.matchType === 'NEARBY'
      ? dispatchPoint
      : ((primary ? pointOf(primary) : undefined) ?? dispatchPoint);
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

  if (match.matchType === 'CANDIDATES') {
    const candidates = match.candidates.map(candidateView);
    return {
      matchType: 'CANDIDATES',
      matchedAddress: candidates[0]?.matchedAddress ?? '',
      unit: null,
      hazards: [],
      utilityShutoffs: [],
      nearestHydrants,
      candidates,
    };
  }
  const { copy } = match;
  return {
    matchType: match.matchType,
    matchedAddress: addressOf(copy),
    unit: copy.addressUnit ?? null,
    ...(match.distanceMeters !== undefined ? { distanceMeters: match.distanceMeters } : {}),
    ...(copy.summary ? { summary: copy.summary } : {}),
    hazards: copy.hazards ?? [],
    utilityShutoffs: copy.utilityShutoffs ?? [],
    nearestHydrants,
  };
}
