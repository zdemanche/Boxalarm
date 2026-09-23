export interface GeoPoint {
  readonly latitude: number;
  readonly longitude: number;
}

export interface NearestHydrant {
  readonly hydrantId: string;
  readonly status?: string;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly size?: string;
  readonly flowRatingGpm?: number;
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
  const latitude = typeof raw?.latitude === 'number' ? raw.latitude : undefined;
  const longitude = typeof raw?.longitude === 'number' ? raw.longitude : undefined;
  const size = typeof raw?.size === 'string' ? raw.size : undefined;
  const flowRatingGpm = typeof raw?.flowRatingGpm === 'number' ? raw.flowRatingGpm : undefined;
  return {
    hydrantId,
    deptId,
    ...(status !== undefined ? { status } : {}),
    ...(latitude !== undefined ? { latitude } : {}),
    ...(longitude !== undefined ? { longitude } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(flowRatingGpm !== undefined ? { flowRatingGpm } : {}),
  };
}

const EARTH_RADIUS_METERS = 6_371_000;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h));
}

function hasCoordinates(point: Pick<NearestHydrant, 'latitude' | 'longitude'>): point is GeoPoint {
  return typeof point.latitude === 'number' && typeof point.longitude === 'number';
}

// ponytail: referenceLocation is always null on the real event path today — PRE_PLAN_COPY
// carries no occupancy lat/long (Data Model §3.1) and the isolation boundary forbids reading
// it from the LOB plane's occupancy config — so distance-based insertion is exercised only by
// direct unit tests until a producer-side fix supplies a reference point. Refresh-in-place and
// OUT_OF_SERVICE pruning remain fully functional without it.
export function resolveNearestHydrants(
  existing: readonly NearestHydrant[],
  update: HydrantUpdatePayload,
  referenceLocation: GeoPoint | null,
  maxResults = 5,
): readonly NearestHydrant[] {
  const isOutOfService = update.status === 'OUT_OF_SERVICE';
  const withoutUpdated = existing.filter((hydrant) => hydrant.hydrantId !== update.hydrantId);

  if (isOutOfService) {
    return withoutUpdated;
  }

  const updatedEntry: NearestHydrant = {
    hydrantId: update.hydrantId,
    ...(update.status !== undefined ? { status: update.status } : {}),
    ...(update.latitude !== undefined ? { latitude: update.latitude } : {}),
    ...(update.longitude !== undefined ? { longitude: update.longitude } : {}),
    ...(update.size !== undefined ? { size: update.size } : {}),
    ...(update.flowRatingGpm !== undefined ? { flowRatingGpm: update.flowRatingGpm } : {}),
  };

  const wasReferenced = existing.some((hydrant) => hydrant.hydrantId === update.hydrantId);
  if (wasReferenced) {
    return existing.map((hydrant) =>
      hydrant.hydrantId === update.hydrantId ? { ...hydrant, ...updatedEntry } : hydrant,
    );
  }

  if (referenceLocation === null || !hasCoordinates(updatedEntry)) {
    return existing;
  }

  const ranked = [...withoutUpdated, updatedEntry]
    .map((hydrant) => ({
      hydrant,
      distance: hasCoordinates(hydrant)
        ? haversineMeters(referenceLocation, hydrant)
        : Number.POSITIVE_INFINITY,
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, maxResults);

  return ranked.map((entry) => entry.hydrant);
}
