import { haversineMeters, isGeoPoint, type GeoPoint } from './geo.js';

export const MAX_NEAREST_HYDRANTS = 5;

/** NFPA 291 marking class, from rated flow at 20 psi residual. */
export type FlowClass = 'AA' | 'A' | 'B' | 'C';

export function flowClassFor(flowRatingGpm: number | undefined): FlowClass | undefined {
  if (typeof flowRatingGpm !== 'number' || !Number.isFinite(flowRatingGpm) || flowRatingGpm < 0) {
    return undefined;
  }
  if (flowRatingGpm >= 1500) return 'AA';
  if (flowRatingGpm >= 1000) return 'A';
  if (flowRatingGpm >= 500) return 'B';
  return 'C';
}

export interface HydrantUpdatePayload {
  readonly hydrantId: string;
  readonly deptId: string;
  readonly status?: string;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly size?: string;
  readonly flowRatingGpm?: number;
}

export function parseHydrantUpdatePayload(payload: unknown): HydrantUpdatePayload {
  const raw = payload as Record<string, unknown> | undefined;
  const hydrantId = raw?.hydrantId;
  const deptId = raw?.deptId;
  if (typeof hydrantId !== 'string' || hydrantId.length === 0) {
    throw new Error('inspections.hydrant.updated payload is missing hydrantId');
  }
  if (typeof deptId !== 'string' || deptId.length === 0) {
    throw new Error('inspections.hydrant.updated payload is missing deptId');
  }
  const status = typeof raw?.status === 'string' ? raw.status : undefined;
  const location = { latitude: raw?.latitude, longitude: raw?.longitude };
  const size = typeof raw?.size === 'string' ? raw.size : undefined;
  const flowRatingGpm = typeof raw?.flowRatingGpm === 'number' ? raw.flowRatingGpm : undefined;
  return {
    hydrantId,
    deptId,
    ...(status !== undefined ? { status } : {}),
    // Both or neither: a half-located hydrant cannot be placed on the geo index.
    ...(isGeoPoint(location) ? { latitude: location.latitude, longitude: location.longitude } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(flowRatingGpm !== undefined ? { flowRatingGpm } : {}),
  };
}

/** A HYDRANT_COPY item as the geo index returns it. */
export interface HydrantCopy {
  readonly hydrantId: string;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly status?: string;
  readonly size?: string;
  readonly flowRatingGpm?: number;
}

/** One entry of the dispatch detail's prePlan.nearestHydrants. */
export interface NearestHydrant {
  readonly hydrantId: string;
  readonly status?: string;
  readonly size?: string;
  readonly flowRatingGpm?: number;
  readonly flowClass?: FlowClass;
  readonly latitude: number;
  readonly longitude: number;
  readonly distanceMeters: number;
}

/**
 * The closest usable hydrants to `reference`, nearest first. OUT_OF_SERVICE hydrants are
 * never offered (a crew cannot use them), nor are copies with no location. Ties break on
 * hydrantId so the list is stable between refreshes.
 */
export function rankNearestHydrants(
  reference: GeoPoint,
  candidates: readonly HydrantCopy[],
  maxResults = MAX_NEAREST_HYDRANTS,
): readonly NearestHydrant[] {
  const byId = new Map<string, { readonly hydrant: NearestHydrant; readonly exact: number }>();
  for (const hydrant of candidates) {
    if (hydrant.status === 'OUT_OF_SERVICE') continue;
    const location = { latitude: hydrant.latitude, longitude: hydrant.longitude };
    if (!isGeoPoint(location) || byId.has(hydrant.hydrantId)) continue;
    const flowClass = flowClassFor(hydrant.flowRatingGpm);
    const exact = haversineMeters(reference, location);
    byId.set(hydrant.hydrantId, {
      exact,
      hydrant: {
        hydrantId: hydrant.hydrantId,
        ...(hydrant.status !== undefined ? { status: hydrant.status } : {}),
        ...(hydrant.size !== undefined ? { size: hydrant.size } : {}),
        ...(hydrant.flowRatingGpm !== undefined ? { flowRatingGpm: hydrant.flowRatingGpm } : {}),
        ...(flowClass !== undefined ? { flowClass } : {}),
        latitude: location.latitude,
        longitude: location.longitude,
        distanceMeters: Math.round(exact),
      },
    });
  }
  return [...byId.values()]
    .sort((a, b) => a.exact - b.exact || a.hydrant.hydrantId.localeCompare(b.hydrant.hydrantId))
    .slice(0, maxResults)
    .map((entry) => entry.hydrant);
}
