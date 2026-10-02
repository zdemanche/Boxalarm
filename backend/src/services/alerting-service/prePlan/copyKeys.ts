import { buildDeptScopedPk, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { encodeGeohash, type GeoPoint } from './geo.js';

/**
 * Alerting-table keys for the read-only copies of LOB pre-plan and hydrant data. Both copies
 * are written only by alerting-owned consumers and read only by the dispatch-detail route.
 *
 * PRE_PLAN_COPY   partition DEPT#{d}#PREPLAN         sk OCCUPANCY#{occupancyId}
 *   GSI1 (address)  gsi1pk = DEPT#{d}#PREPLAN_ADDR#{normalized street key}
 *                   gsi1sk = OCCUPANCY#{occupancyId}
 *   GSI2 (location) gsi2pk = DEPT#{d}#PREPLAN_GEO#{geohash6}
 *                   gsi2sk = {geohash9}#{occupancyId}
 * HYDRANT_COPY    partition DEPT#{d}#HYDRANT         sk HYDRANT#{hydrantId}
 *   GSI2 (location) gsi2pk = DEPT#{d}#HYDRANT_GEO#{geohash5}
 *                   gsi2sk = {geohash9}#{hydrantId}
 *
 * The index keys ride on the copy item itself (not a second pointer item), so a copy can never
 * be findable under a stale key that no transaction cleaned up.
 */

export const PREPLAN_GEO_PARTITION_PRECISION = 6;
/** geohash7 cells are ~150 m x ~115 m here, so the 3x3 ring always covers the 50 m match radius. */
export const PREPLAN_GEO_SEARCH_PRECISION = 7;

export const HYDRANT_GEO_PARTITION_PRECISION = 5;
/** Nearest-hydrant search widens from geohash6 (~0.6 km ring) to geohash5 (~3 km ring). */
export const HYDRANT_GEO_SEARCH_PRECISIONS: readonly number[] = [6, 5];

export const GEO_INDEX_NAME = 'GSI2';
export const ADDRESS_INDEX_NAME = 'GSI1';

export function prePlanCopyKey(deptId: VerifiedDeptId, occupancyId: string) {
  return { pk: buildDeptScopedPk(deptId, 'PREPLAN'), sk: `OCCUPANCY#${occupancyId}` };
}

export function prePlanAddressPartition(deptId: VerifiedDeptId, addressKey: string): string {
  return buildDeptScopedPk(deptId, 'PREPLAN_ADDR', addressKey);
}

export function prePlanAddressIndexKeys(
  deptId: VerifiedDeptId,
  addressKey: string,
  occupancyId: string,
) {
  return {
    gsi1pk: prePlanAddressPartition(deptId, addressKey),
    gsi1sk: `OCCUPANCY#${occupancyId}`,
  };
}

/** The GSI2 partition holding every copy whose geohash starts with `cell`. */
export function geoPartitionForCell(
  deptId: VerifiedDeptId,
  kind: 'PREPLAN_GEO' | 'HYDRANT_GEO',
  cell: string,
): string {
  const precision =
    kind === 'PREPLAN_GEO' ? PREPLAN_GEO_PARTITION_PRECISION : HYDRANT_GEO_PARTITION_PRECISION;
  if (cell.length < precision) {
    throw new Error(`a ${kind} search cell needs at least ${precision} geohash characters`);
  }
  return buildDeptScopedPk(deptId, kind, cell.slice(0, precision));
}

export function prePlanGeoIndexKeys(deptId: VerifiedDeptId, point: GeoPoint, occupancyId: string) {
  const hash = encodeGeohash(point);
  return {
    geohash: hash,
    gsi2pk: geoPartitionForCell(deptId, 'PREPLAN_GEO', hash),
    gsi2sk: `${hash}#${occupancyId}`,
  };
}

export function hydrantCopyKey(deptId: VerifiedDeptId, hydrantId: string) {
  return { pk: buildDeptScopedPk(deptId, 'HYDRANT'), sk: `HYDRANT#${hydrantId}` };
}

export function hydrantGeoIndexKeys(deptId: VerifiedDeptId, point: GeoPoint, hydrantId: string) {
  const hash = encodeGeohash(point);
  return {
    geohash: hash,
    gsi2pk: geoPartitionForCell(deptId, 'HYDRANT_GEO', hash),
    gsi2sk: `${hash}#${hydrantId}`,
  };
}
