import type { ComponentType } from 'react';
import type { BoundingBox, MapHydrant, MapOccupancy } from './types';

/**
 * Port the map screen renders through (E5-S6). This module stays free of any map vendor SDK.
 * `leafletMapProvider` is one implementation behind the port; MapPage never imports the vendor.
 */
export interface MapViewProps {
  bbox: BoundingBox;
  occupancies: readonly MapOccupancy[];
  hydrants: readonly MapHydrant[];
  onOccupancySelect: (occupancyId: string) => void;
}

export interface MapProvider {
  MapView: ComponentType<MapViewProps>;
}

export const PAN_STEP_DEGREES = 0.01;
export const MIN_SPAN_DEGREES = 0.005;
export const MAX_SPAN_DEGREES = 2;

export function panBoundingBox(bbox: BoundingBox, dLat: number, dLng: number): BoundingBox {
  return {
    minLat: bbox.minLat + dLat,
    maxLat: bbox.maxLat + dLat,
    minLng: bbox.minLng + dLng,
    maxLng: bbox.maxLng + dLng,
  };
}

export function zoomBoundingBox(bbox: BoundingBox, factor: number): BoundingBox {
  const centerLat = (bbox.minLat + bbox.maxLat) / 2;
  const centerLng = (bbox.minLng + bbox.maxLng) / 2;
  const latSpan = Math.min(
    Math.max((bbox.maxLat - bbox.minLat) * factor, MIN_SPAN_DEGREES),
    MAX_SPAN_DEGREES,
  );
  const lngSpan = Math.min(
    Math.max((bbox.maxLng - bbox.minLng) * factor, MIN_SPAN_DEGREES),
    MAX_SPAN_DEGREES,
  );
  return {
    minLat: centerLat - latSpan / 2,
    maxLat: centerLat + latSpan / 2,
    minLng: centerLng - lngSpan / 2,
    maxLng: centerLng + lngSpan / 2,
  };
}

export function mergeOccupancies(
  existing: ReadonlyMap<string, MapOccupancy>,
  incoming: readonly MapOccupancy[],
): Map<string, MapOccupancy> {
  const merged = new Map(existing);
  for (const occupancy of incoming) merged.set(occupancy.occupancyId, occupancy);
  return merged;
}

export function mergeHydrants(
  existing: ReadonlyMap<string, MapHydrant>,
  incoming: readonly MapHydrant[],
): Map<string, MapHydrant> {
  const merged = new Map(existing);
  for (const hydrant of incoming) merged.set(hydrant.hydrantId, hydrant);
  return merged;
}
