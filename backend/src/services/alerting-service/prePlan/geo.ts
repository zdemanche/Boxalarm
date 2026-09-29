import geohash from 'ngeohash';

export interface GeoPoint {
  readonly latitude: number;
  readonly longitude: number;
}

const EARTH_RADIUS_METERS = 6_371_000;
const METERS_PER_DEGREE_LATITUDE = 111_320;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h));
}

export function isGeoPoint(value: {
  readonly latitude?: unknown;
  readonly longitude?: unknown;
}): value is GeoPoint {
  return (
    typeof value.latitude === 'number' &&
    typeof value.longitude === 'number' &&
    Number.isFinite(value.latitude) &&
    Number.isFinite(value.longitude) &&
    value.latitude >= -90 &&
    value.latitude <= 90 &&
    value.longitude >= -180 &&
    value.longitude <= 180
  );
}

/** Full-resolution geohash stored in a copy's GSI sort key (~5 m cells). */
export const STORED_GEOHASH_PRECISION = 9;

export function encodeGeohash(point: GeoPoint, precision = STORED_GEOHASH_PRECISION): string {
  return geohash.encode(point.latitude, point.longitude, precision);
}

/**
 * One cell per partition-and-prefix Query: the point's own cell at `precision` plus its eight
 * neighbours, so every location within `guaranteedRadiusMeters` of the point is covered
 * whichever side of a cell edge it falls on.
 */
export interface SearchRing {
  readonly cells: readonly string[];
  readonly guaranteedRadiusMeters: number;
}

export function searchRing(point: GeoPoint, precision: number): SearchRing {
  const center = encodeGeohash(point, precision);
  const [minLat, minLon, maxLat, maxLon] = geohash.decode_bbox(center);
  const cellHeightMeters = (maxLat - minLat) * METERS_PER_DEGREE_LATITUDE;
  const cellWidthMeters =
    (maxLon - minLon) * METERS_PER_DEGREE_LATITUDE * Math.cos(toRadians(point.latitude));
  return {
    cells: [center, ...geohash.neighbors(center)],
    // The point sits somewhere inside the centre cell, so the 3x3 block extends at least one
    // full cell beyond it in every direction.
    guaranteedRadiusMeters: Math.min(cellHeightMeters, cellWidthMeters),
  };
}
