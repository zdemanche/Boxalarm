import { LeafletMap } from './LeafletMap';
import type { MapProvider } from './mapProvider';

/** Leaflet renderer behind the MapProvider port. The only module that may import LeafletMap. */
export const leafletMapProvider: MapProvider = {
  MapView: LeafletMap,
};
