import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { logError } from '../dispatches/logger.js';
import { normalizeAddress } from './addressKey.js';
import { judgeLocality, type HomeLocality } from './locality.js';
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
  isOutOfService,
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
const METRIC_NAMESPACE = 'Boxalarm/alerting-pre-plan';

/** The address read hit its cap: the detail shows "pre-plan unavailable", never "no match". */
export class PrePlanLookupIncompleteError extends Error {
  constructor(key: string) {
    super(`address candidates for "${key}" exceeded the read cap`);
    this.name = 'PrePlanLookupIncompleteError';
  }
}

interface QueryResult {
  readonly items: Record<string, unknown>[];
  /** The page cap stopped the read with items left: the result is a subset. */
  readonly truncated: boolean;
}

/**
 * Hydrant copies read per geohash cell, at most. The widened (geohash5, ~5 km) ring would
 * otherwise read most of a rural department's hydrants on every detail view; 9 cells x 200
 * bounds it to ~1,800 small projected items (~45 RCU), and a cell that holds more is reported
 * as a truncated read (the hydrant list is then marked incomplete).
 */
export const MAX_HYDRANTS_PER_CELL = 200;

async function queryAll(
  client: DynamoDBDocumentClient,
  input: ConstructorParameters<typeof QueryCommand>[0],
  maxItems = Number.POSITIVE_INFINITY,
): Promise<QueryResult> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  let pages = 0;
  do {
    const remaining = maxItems - items.length;
    const output = await client.send(
      new QueryCommand({
        ...input,
        ...(Number.isFinite(remaining) ? { Limit: remaining } : {}),
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    items.push(...((output?.Items ?? []) as Record<string, unknown>[]));
    exclusiveStartKey = output?.LastEvaluatedKey as Record<string, unknown> | undefined;
    pages += 1;
  } while (
    exclusiveStartKey !== undefined &&
    pages < MAX_PAGES_PER_QUERY &&
    items.length < maxItems
  );
  return { items, truncated: exclusiveStartKey !== undefined };
}

/** A capped read is never silent: it is logged and counted (CopyQueryTruncated, by lookup). */
function reportTruncation(lookup: string, deptId: VerifiedDeptId, key: string): void {
  logError('preplan_copy.query_truncated', new Error('query stopped at its page cap'), {
    lookup,
    deptId,
    key,
  });
  emitOutcomeMetric(METRIC_NAMESPACE, 'CopyQueryTruncated', lookup);
}

function isPrePlanCopy(
  item: Record<string, unknown>,
): item is Record<string, unknown> & PrePlanCopyItem {
  // Tombstoned copies lose their index keys; the archivedAt check is belt and braces.
  return (
    item.entityType === 'PRE_PLAN_COPY' &&
    typeof item.occupancyId === 'string' &&
    item.archivedAt === undefined
  );
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
/**
 * ADDRESS / ADDRESS_BUILDING are the only unflagged types: same key, both addresses parsed
 * unambiguously, locality verified (locality.ts). Everything else is shown "verify address".
 */
export type PrePlanMatchType =
  'ADDRESS' | 'ADDRESS_BUILDING' | 'ADDRESS_UNVERIFIED' | 'UNIT_MISMATCH' | 'NEARBY' | 'CANDIDATES';

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
 * The pre-plan(s) whose normalized street address equals the dispatch's, not in a different
 * town/ZIP/state (locality.ts, against the department's home locality) and within 150 m (when
 * both have coordinates), resolved by unit. A single match that could not be verified comes
 * back as ADDRESS_UNVERIFIED, never as a plain ADDRESS.
 */
export async function findPrePlanByAddress(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  address: string,
  dispatchPoint: GeoPoint | undefined,
  home: HomeLocality,
): Promise<PrePlanMatch | undefined> {
  // Home village names count as places when reading trailing words (never for the key).
  const normalized = normalizeAddress(address, home.towns);
  if (!normalized) {
    return undefined;
  }
  const { items, truncated } = await queryAll(client, {
    TableName: tableName,
    IndexName: ADDRESS_INDEX_NAME,
    KeyConditionExpression: 'gsi1pk = :gsi1pk',
    ExpressionAttributeValues: { ':gsi1pk': prePlanAddressPartition(deptId, normalized.key) },
    Limit: ADDRESS_CANDIDATE_LIMIT,
  });
  if (truncated) {
    // Unit resolution over a partial candidate set could pick the wrong plan, and "no match"
    // would be a lie: report the lookup as unavailable.
    reportTruncation('address', deptId, normalized.key);
    throw new PrePlanLookupIncompleteError(normalized.key);
  }
  // Each candidate is re-read from its own address (never trusting stored unit/town fields,
  // which an older normalizer may have written) and judged against the dispatch's locality.
  const judged = items
    .filter(isPrePlanCopy)
    .filter((candidate) => closeEnough(dispatchPoint, candidate))
    .flatMap((candidate) => {
      const parsed = candidate.address ? normalizeAddress(candidate.address, home.towns) : null;
      if (!parsed || parsed.key !== normalized.key) {
        // Indexed under a key the current rules no longer give its address (written by an
        // older normalizer; the replay re-keys it): under today's rules it is another street.
        return [];
      }
      const verdict = judgeLocality(normalized, parsed, home);
      if (verdict === 'REJECT') return [];
      // The unit as the current rules read it, replacing whatever an older rule stored.
      const copy: PrePlanCopyItem = { ...candidate };
      delete (copy as { addressUnit?: string }).addressUnit;
      if (parsed.unit) (copy as { addressUnit?: string }).addressUnit = parsed.unit;
      return [{ copy, verdict }];
    });
  const match = resolveUnit(
    normalized.unit,
    judged.map((entry) => entry.copy),
  );
  if (match && (match.matchType === 'ADDRESS' || match.matchType === 'ADDRESS_BUILDING')) {
    const verdict = judged.find(
      (entry) => entry.copy.occupancyId === match.copy.occupancyId,
    )?.verdict;
    if (verdict !== 'VERIFIED') {
      return { matchType: 'ADDRESS_UNVERIFIED', copy: match.copy };
    }
  }
  return match;
}

/**
 * Pre-plans whose occupancy lies within 50 m of `point` — used only for a dispatch with no
 * usable street address. One is NEARBY (flagged, with its distance); several are CANDIDATES,
 * nearest first. Never "the nearest": 50 m spans two or three suburban parcels.
 */
export async function findPrePlanNear(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  point: GeoPoint,
): Promise<PrePlanMatch | undefined> {
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
  if (pages.some((page) => page.truncated)) {
    // Every NEARBY/CANDIDATES result is already flagged "verify address"; still, say so.
    reportTruncation('preplan-geo', deptId, cells[0] ?? '');
  }
  const within: Array<PrePlanCandidate & { readonly distanceMeters: number }> = [];
  const seen = new Set<string>();
  for (const item of pages.flatMap((page) => page.items).filter(isPrePlanCopy)) {
    const location = { latitude: item.latitude, longitude: item.longitude };
    if (!isGeoPoint(location) || seen.has(item.occupancyId)) continue;
    seen.add(item.occupancyId);
    const distance = haversineMeters(point, location);
    if (distance <= PREPLAN_MATCH_RADIUS_METERS) {
      within.push({ copy: item, distanceMeters: Math.round(distance) });
    }
  }
  within.sort(
    (a, b) =>
      a.distanceMeters - b.distanceMeters || a.copy.occupancyId.localeCompare(b.copy.occupancyId),
  );
  if (within.length === 0) return undefined;
  if (within.length === 1) {
    const [only] = within as [(typeof within)[number]];
    return { matchType: 'NEARBY', copy: only.copy, distanceMeters: only.distanceMeters };
  }
  return { matchType: 'CANDIDATES', candidates: within };
}

async function queryHydrantCells(
  client: DynamoDBDocumentClient,
  tableName: string,
  deptId: VerifiedDeptId,
  cells: readonly string[],
): Promise<{ readonly hydrants: HydrantCopy[]; readonly truncated: boolean }> {
  const pages = await Promise.all(
    cells.map((cell) =>
      queryAll(
        client,
        {
          TableName: tableName,
          IndexName: GEO_INDEX_NAME,
          KeyConditionExpression: 'gsi2pk = :gsi2pk AND begins_with(gsi2sk, :cell)',
          ExpressionAttributeValues: {
            ':gsi2pk': geoPartitionForCell(deptId, 'HYDRANT_GEO', cell),
            ':cell': cell,
          },
          ProjectionExpression:
            'entityType, hydrantId, latitude, longitude, #status, #size, flowRatingGpm, archivedAt',
          ExpressionAttributeNames: { '#status': 'status', '#size': 'size' },
        },
        MAX_HYDRANTS_PER_CELL,
      ),
    ),
  );
  return {
    hydrants: pages
      .flatMap((page) => page.items)
      .filter((item) => item.entityType === 'HYDRANT_COPY' && typeof item.hydrantId === 'string')
      .map((item) => item as unknown as HydrantCopy),
    truncated: pages.some((page) => page.truncated),
  };
}

export interface NearestHydrantsResult {
  readonly hydrants: readonly NearestHydrant[];
  /** A geo partition read hit its cap: a nearer hydrant may be missing from the list. */
  readonly incomplete: boolean;
}

/**
 * The nearest usable hydrants to `point` (plus nearer out-of-service ones, flagged), searched in widening geohash rings: a ring's result
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
): Promise<NearestHydrantsResult> {
  let ranked: readonly NearestHydrant[] = [];
  let incomplete = false;
  // Every ring's hydrants are kept: a capped wide read (first N copies of a dense ~5 km cell,
  // in geohash order) must never lose the close hydrants the narrow ring already found.
  const seen = new Map<string, HydrantCopy>();
  for (const precision of HYDRANT_GEO_SEARCH_PRECISIONS) {
    const ring = searchRing(point, precision);
    const read = await queryHydrantCells(client, tableName, deptId, ring.cells);
    if (read.truncated) {
      incomplete = true;
      reportTruncation('hydrant-geo', deptId, ring.cells[0] ?? '');
    }
    for (const hydrant of read.hydrants) {
      if (!seen.has(hydrant.hydrantId)) seen.set(hydrant.hydrantId, hydrant);
    }
    ranked = rankNearestHydrants(point, [...seen.values()], max);
    const covered = ranked.filter(
      (hydrant) => hydrant.distanceMeters <= ring.guaranteedRadiusMeters,
    );
    // Only usable hydrants count toward `max`; flagged out-of-service ones ride along.
    if (!read.truncated && covered.filter((hydrant) => !isOutOfService(hydrant)).length >= max) {
      return { hydrants: covered, incomplete };
    }
  }
  return { hydrants: ranked, incomplete };
}
