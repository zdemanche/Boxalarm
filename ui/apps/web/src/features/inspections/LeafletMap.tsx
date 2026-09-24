import { useEffect } from 'react';
import { DivIcon } from 'leaflet';
import { MapContainer, Marker, Popup, TileLayer, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import type { BoundingBox, MapHydrant, MapOccupancy } from './types';

// Colour + glyph, matching StatusChip's status roles (never colour alone, N7.1) — plain SVG
// divIcons so no default Leaflet marker image assets need bundling.
function pinIcon(color: string, glyph: string): DivIcon {
  return new DivIcon({
    className: '',
    html: `<span style="display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:${color};color:#0b0b0d;font-weight:700;font-size:12px;border:2px solid var(--bx-bg, #fff);">${glyph}</span>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

const OCCUPANCY_ICON = pinIcon('var(--bx-status-info, #7cc4ff)', '⌂');
const HYDRANT_OK_ICON = pinIcon('var(--bx-status-ok, #5ddb8a)', '●');
const HYDRANT_OOS_ICON = pinIcon('var(--bx-status-danger, #ff6b5e)', '⊘');

function FitBounds({ bbox }: { bbox: BoundingBox }) {
  const map = useMap();
  useEffect(() => {
    map.fitBounds(
      [
        [bbox.minLat, bbox.minLng],
        [bbox.maxLat, bbox.maxLng],
      ],
      { animate: false },
    );
  }, [map, bbox.minLat, bbox.minLng, bbox.maxLat, bbox.maxLng]);
  return null;
}

interface LeafletMapProps {
  bbox: BoundingBox;
  occupancies: readonly MapOccupancy[];
  hydrants: readonly MapHydrant[];
  onOccupancySelect: (occupancyId: string) => void;
}

export function LeafletMap({ bbox, occupancies, hydrants, onOccupancySelect }: LeafletMapProps) {
  const center: [number, number] = [
    (bbox.minLat + bbox.maxLat) / 2,
    (bbox.minLng + bbox.maxLng) / 2,
  ];

  return (
    <MapContainer
      center={center}
      zoom={14}
      style={{ height: 360, width: '100%' }}
      aria-label="Occupancies and hydrants map"
    >
      <FitBounds bbox={bbox} />
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {occupancies.map((occupancy) => (
        <Marker
          key={occupancy.occupancyId}
          position={[occupancy.latitude, occupancy.longitude]}
          icon={OCCUPANCY_ICON}
          eventHandlers={{ click: () => onOccupancySelect(occupancy.occupancyId) }}
        >
          <Popup>{occupancy.occupancyId}</Popup>
        </Marker>
      ))}
      {hydrants.map((hydrant) => (
        <Marker
          key={hydrant.hydrantId}
          position={[hydrant.latitude, hydrant.longitude]}
          icon={hydrant.status === 'OUT_OF_SERVICE' ? HYDRANT_OOS_ICON : HYDRANT_OK_ICON}
        >
          <Popup>
            {hydrant.hydrantId} —{' '}
            {hydrant.status === 'OUT_OF_SERVICE' ? 'Out of service' : 'In service'}
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}
