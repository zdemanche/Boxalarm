import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { VerifiedDeptId } from '@boxalarm/dept-scope';
import { normalizeAddress, type NormalizedAddress } from './addressKey.js';
import {
  ADDRESS_INDEX_NAME,
  GEO_INDEX_NAME,
  HYDRANT_GEO_SEARCH_PRECISIONS,
  PREPLAN_GEO_SEARCH_PRECISION,
  geoPartitionForCell,
  prePlanAddressPartition,
} from './copyKeys.js';
import { haversineMeters, isGeoPoint, searchRing, type GeoPoint } from './geo.js';
import {
  MAX_NEAREST_HYDRANTS,
  rankNearestHydrants,
  type HydrantCopy,
  type NearestHydrant,
} from './nearestHydrants.js';

export interface UtilityShutoff {
  readonly utility: string;
  readonly location: string;
}

export interface PrePlanCopyItem {
  readonly occupancyId: string;
  readonly summary?: string;
  readonly address?: string;
  readonly addressUnit?: string;
  readonly addressTown?: string;
  readonly addressZip?: string;
  readonly hazards?: readonly string[];
  readonly utilityShutoffs?: readonly UtilityShutoff[];
  readonly latitude?: number;
  readonly longitude?: number;
  readonly snapshotUpdatedAt?: number;
}

/**
 * An address match is rejected when the dispatch and the occupancy both carry coordinates and
 * they are farther apart than this — same key, different place (a street that crosses a town
 * line, or a normalizer collision).
 */
export const ADDRESS_MATCH_MAX_DISTANCE_METERS = 150;

/** A dispatch coordinate within this distance of an occupancy is treated as that occupancy. */
export const PREPLAN_MATCH_RADIUS_METERS = 50;

/** Bounds a runaway partition read; a department's hydrants fill ~one page per geohash5 cell. */
const MAX_PAGES_PER_QUERY = 5;
const ADDRESS_CANDIDATE_LIMIT = 25;

async function queryAll(
  client: DynamoDBDocumentClient,
  input: ConstructorParameters<typeof QueryCommand>[0],
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  let pages = 0;
  do {
    const output = await client.send(
      new QueryCommand({
        ...input,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    items.push(...((output?.Items ?? []) as Record<string, unknown>[]));
    exclusiveStartKey = output?.LastEvaluatedKey as Record<string, unknown> | undefined;
    pages += 1;
  } while (exclusiveStartKey !== undefined && pages < MAX_PAGES_PER_QUERY);
  return items;
}

function isPrePlanCopy(
  item: Record<string, unknown>,
): item is Record<string, unknown> & PrePlanCopyItem {
  return item.entityType === 'PRE_PLAN_COPY' && typeof item.occupancyId === 'string';
}

/** Rejects a candidate whose town or ZIP differs — only when both sides carry one. */
function sameLocality(dispatch: NormalizedAddress, candidate: PrePlanCopyItem): boolean {
  if (dispatch.town && candidate.addressTown && dispatch.town !== candidate.addressTown) {
    return false;
  }
  return !(dispatch.zip && candidate.addressZip && dispatch.zip !== candidate.addressZip);
}

/** Rejects a candidate far from the dispatch point — only when both sides carry coordinates. */
function closeEnough(dispatchPoint: GeoPoint | undefined, candidate: PrePlanCopyItem): boolean {
  const location = { latitude: candidate.latitude, longitude: candidate.longitude };
  if (!dispatchPoint || !isGeoPoint(location)) {
    return true;
  }
  return haversineMeters(dispatchPoint, location) <= ADDRESS_MATCH_MAX_DISTANCE_METERS;
}

/** How a pre-plan was tied to the dispatch — shown to the crew, never hidden. */
export type PrePlanMatchType =
  'ADDRESS' | 'ADDRESS_BUILDING' | 'UNIT_MISMATCH' | 'NEARBY' | 'CANDIDATES';

export interface PrePlanCandidate {
  readonly copy: PrePlanCopyItem;
  /** Meters from the dispatch point, when both have coordinates. */
  readonly distanceMeters?: number;
}

export type PrePlanMatch =
  | {
      readonly matchType: Exclude<PrePlanMatchType, 'CANDIDATES'>;
      readonly copy: PrePlanCopyItem;
      readonly distanceMeters?: number;
    }
  | { readonly matchType: 'CANDIDATES'; readonly candidates: readonly PrePlanCandidate[] };

/**
 * Picks among same-address copies only when the choice is unambiguous; a wrong pre-plan is
 * worse than none, so anything else is returned as CANDIDATES for the crew to choose from.
 *  - the dispatch's own unit (exactly one) -> ADDRESS
 *  - else the building-level plan (exactly one) -> ADDRESS when the dispatch named no unit,
 *    ADDRESS_BUILDING when it did
 *  - else a lone plan for some other unit -> UNIT_MISMATCH (flagged)
 *  - else (several, or duplicates of the same unit) -> CANDIDATES
 */
export function resolveUnit(
  dispatchUnit: string | null,
  candidates: readonly PrePlanCopyItem[],
): PrePlanMatch | undefined {
  if (candidates.length === 0) {
    return undefined;
  }
  const asCandidates = (): PrePlanMatch => ({
    matchType: 'CANDIDATES',
    candidates: [...candidates].sort(byUnit).map((copy) => ({ copy })),
  });
  if (dispatchUnit !== null) {
    const sameUnit = candidates.filter((c) => c.addressUnit === dispatchUnit);
    if (sameUnit.length === 1)
      return { matchType: 'ADDRESS', copy: sameUnit[0] as PrePlanCopyItem };
    if (sameUnit.length > 1) return asCandidates();
  }
  const building = candidates.filter((c) => c.addressUnit === undefined);
  if (building.length === 1) {
    return {
      matchType: dispatchUnit === null ? 'ADDRESS' : 'ADDRESS_BUILDING',
      copy: building[0] as PrePlanCopyItem,
    };
  }
  if (building.length === 0 && candidates.length === 1) {
    return { matchType: 'UNIT_MISMATCH', copy: candidates[0] as PrePlanCopyItem };
  }
  return asCandidates();
}

function byUnit(a: PrePlanCopyItem, b: PrePlanCopyItem): number {
  return (
    (a.addressUnit ?? '').localeCompare(b.addressUnit ?? '') ||
    a.occupancyId.localeCompare(b.occupancyId)
  );
}

/**
 * The pre-plan(s) whose normalized street address equals the dispatch's, in the same town/ZIP
 * (when both say) and within 150 m (when both have coordinates), resolved by unit.
 */
export async function findPrePlanByAddress(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  address: string,
  dispatchPoint?: GeoPoint,
): Promise<PrePlanMatch | undefined> {
  const normalized = normalizeAddress(address);
  if (!normalized) {
    return undefined;
  }
  const items = await queryAll(client, {
    TableName: tableName,
    IndexName: ADDRESS_INDEX_NAME,
    KeyConditionExpression: 'gsi1pk = :gsi1pk',
    ExpressionAttributeValues: { ':gsi1pk': prePlanAddressPartition(deptId, normalized.key) },
    Limit: ADDRESS_CANDIDATE_LIMIT,
  });
  const candidates = items
    .filter(isPrePlanCopy)
    .filter((candidate) => sameLocality(normalized, candidate))
    .filter((candidate) => closeEnough(dispatchPoint, candidate));
  return resolveUnit(normalized.unit, candidates);
}

/** The pre-plan whose occupancy is nearest `point`, if one lies within the match radius. */
export async function findPrePlanNear(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  point: GeoPoint,
): Promise<PrePlanCopyItem | undefined> {
  const { cells } = searchRing(point, PREPLAN_GEO_SEARCH_PRECISION);
  const pages = await Promise.all(
    cells.map((cell) =>
      queryAll(client, {
        TableName: tableName,
        IndexName: GEO_INDEX_NAME,
        KeyConditionExpression: 'gsi2pk = :gsi2pk AND begins_with(gsi2sk, :cell)',
        ExpressionAttributeValues: {
          ':gsi2pk': geoPartitionForCell(deptId, 'PREPLAN_GEO', cell),
          ':cell': cell,
        },
      }),
    ),
  );
  let best: { readonly item: PrePlanCopyItem; readonly distance: number } | undefined;
  for (const item of pages.flat().filter(isPrePlanCopy)) {
    const location = { latitude: item.latitude, longitude: item.longitude };
    if (!isGeoPoint(location)) continue;
    const distance = haversineMeters(point, location);
    if (distance > PREPLAN_MATCH_RADIUS_METERS) continue;
    if (!best || distance < best.distance) {
      best = { item, distance };
    }
  }
  return best?.item;
}

async function queryHydrantCells(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  cells: readonly string[],
): Promise<HydrantCopy[]> {
  const pages = await Promise.all(
    cells.map((cell) =>
      queryAll(client, {
        TableName: tableName,
        IndexName: GEO_INDEX_NAME,
        KeyConditionExpression: 'gsi2pk = :gsi2pk AND begins_with(gsi2sk, :cell)',
        ExpressionAttributeValues: {
          ':gsi2pk': geoPartitionForCell(deptId, 'HYDRANT_GEO', cell),
          ':cell': cell,
        },
        ProjectionExpression:
          'entityType, hydrantId, latitude, longitude, #status, #size, flowRatingGpm',
        ExpressionAttributeNames: { '#status': 'status', '#size': 'size' },
      }),
    ),
  );
  return pages
    .flat()
    .filter((item) => item.entityType === 'HYDRANT_COPY' && typeof item.hydrantId === 'string')
    .map((item) => item as unknown as HydrantCopy);
}

/**
 * The nearest usable hydrants to `point`, searched in widening geohash rings: a ring's result
 * is final once it holds `max` hydrants inside the distance that ring fully covers; otherwise
 * the next, wider ring is read. Past the widest ring the list is best-effort (it may include a
 * hydrant slightly farther than one just outside the ring) — acceptable at ~3 km.
 */
export async function findNearestHydrants(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  point: GeoPoint,
  max = MAX_NEAREST_HYDRANTS,
): Promise<readonly NearestHydrant[]> {
  let ranked: readonly NearestHydrant[] = [];
  for (const precision of HYDRANT_GEO_SEARCH_PRECISIONS) {
    const ring = searchRing(point, precision);
    ranked = rankNearestHydrants(
      point,
      await queryHydrantCells(client, tableName, deptId, ring.cells),
      max,
    );
    const covered = ranked.filter(
      (hydrant) => hydrant.distanceMeters <= ring.guaranteedRadiusMeters,
    );
    if (covered.length >= max) {
      return covered;
    }
  }
  return ranked;
}
