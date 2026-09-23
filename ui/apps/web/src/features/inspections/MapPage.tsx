import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { queryMap } from './api';
import { mergeHydrants, mergeOccupancies, panBoundingBox, zoomBoundingBox } from './mapProvider';
import type { BoundingBox, MapHydrant, MapOccupancy } from './types';

const NICHOLS_FD_CENTER: BoundingBox = {
  minLat: 41.23,
  minLng: -73.21,
  maxLat: 41.27,
  maxLng: -73.17,
};

type View = 'map' | 'list';

export function MapPage() {
  const auth = useAuth();
  const [bbox, setBbox] = useState<BoundingBox>(NICHOLS_FD_CENTER);
  const [occupancies, setOccupancies] = useState<Map<string, MapOccupancy>>(new Map());
  const [hydrants, setHydrants] = useState<Map<string, MapHydrant>>(new Map());
  const [view, setView] = useState<View>('map');

  const mapQuery = useQuery({
    queryKey: ['inspections', 'map', bbox.minLat, bbox.minLng, bbox.maxLat, bbox.maxLng],
    queryFn: async () => {
      const result = await queryMap(auth, bbox);
      setOccupancies((prev) => mergeOccupancies(prev, result.occupancies));
      setHydrants((prev) => mergeHydrants(prev, result.hydrants));
      return result;
    },
  });

  if (mapQuery.error) {
    return (
      <ApiForbiddenGate error={mapQuery.error}>
        <p>Unexpected error</p>
      </ApiForbiddenGate>
    );
  }

  const pan = (dLat: number, dLng: number) => setBbox((prev) => panBoundingBox(prev, dLat, dLng));
  const zoom = (factor: number) => setBbox((prev) => zoomBoundingBox(prev, factor));
  const latSpan = bbox.maxLat - bbox.minLat;
  const lngSpan = bbox.maxLng - bbox.minLng;

  const occupancyList = Array.from(occupancies.values());
  const hydrantList = Array.from(hydrants.values());

  return (
    <main id="main-content" style={{ padding: 'var(--boxalarm-spacing-lg)' }}>
      <h1 style={{ fontSize: 'var(--boxalarm-font-size-xl)', margin: 0 }}>Map</h1>

      <div
        role="group"
        aria-label="Pan and zoom"
        style={{
          display: 'flex',
          gap: 'var(--boxalarm-spacing-sm)',
          marginTop: 'var(--boxalarm-spacing-lg)',
        }}
      >
        <button type="button" onClick={() => pan(latSpan * 0.5, 0)} style={{ minHeight: 44 }}>
          Pan north
        </button>
        <button type="button" onClick={() => pan(-latSpan * 0.5, 0)} style={{ minHeight: 44 }}>
          Pan south
        </button>
        <button type="button" onClick={() => pan(0, -lngSpan * 0.5)} style={{ minHeight: 44 }}>
          Pan west
        </button>
        <button type="button" onClick={() => pan(0, lngSpan * 0.5)} style={{ minHeight: 44 }}>
          Pan east
        </button>
        <button type="button" onClick={() => zoom(0.5)} style={{ minHeight: 44 }}>
          Zoom in
        </button>
        <button type="button" onClick={() => zoom(2)} style={{ minHeight: 44 }}>
          Zoom out
        </button>
      </div>

      <div
        role="tablist"
        aria-label="Map display"
        style={{
          display: 'flex',
          gap: 'var(--boxalarm-spacing-sm)',
          marginTop: 'var(--boxalarm-spacing-md)',
        }}
      >
        {(['map', 'list'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={view === value}
            onClick={() => setView(value)}
            style={{
              minHeight: 44,
              padding: '0 var(--boxalarm-spacing-md)',
              fontWeight: view === value ? 700 : 400,
            }}
          >
            {value === 'map' ? 'Map view' : 'List view'}
          </button>
        ))}
      </div>

      {view === 'map' ? (
        <div
          aria-hidden="true"
          style={{
            position: 'relative',
            marginTop: 'var(--boxalarm-spacing-md)',
            width: '100%',
            height: 320,
            border: '1px solid var(--boxalarm-fg)',
            overflow: 'hidden',
          }}
        >
          {occupancyList.map((occupancy) => (
            <span
              key={occupancy.occupancyId}
              title={occupancy.occupancyId}
              style={{
                position: 'absolute',
                left: `${((occupancy.longitude - bbox.minLng) / lngSpan) * 100}%`,
                top: `${(1 - (occupancy.latitude - bbox.minLat) / latSpan) * 100}%`,
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: 'var(--boxalarm-accent)',
              }}
            />
          ))}
          {hydrantList.map((hydrant) => (
            <span
              key={hydrant.hydrantId}
              title={hydrant.hydrantId}
              style={{
                position: 'absolute',
                left: `${((hydrant.longitude - bbox.minLng) / lngSpan) * 100}%`,
                top: `${(1 - (hydrant.latitude - bbox.minLat) / latSpan) * 100}%`,
                width: 8,
                height: 8,
                background:
                  hydrant.status === 'OUT_OF_SERVICE'
                    ? 'var(--boxalarm-error)'
                    : 'var(--boxalarm-success)',
              }}
            />
          ))}
        </div>
      ) : null}

      <section
        aria-label="Occupancies and hydrants in view"
        style={{ marginTop: 'var(--boxalarm-spacing-lg)' }}
      >
        <h2 style={{ fontSize: 'var(--boxalarm-font-size-lg)', margin: 0 }}>Occupancies</h2>
        {occupancyList.length === 0 ? (
          <p>No occupancies in view.</p>
        ) : (
          <ul>
            {occupancyList.map((occupancy) => (
              <li key={occupancy.occupancyId}>
                <Link to={`/inspections/occupancies/${occupancy.occupancyId}`}>
                  {occupancy.occupancyId}
                </Link>{' '}
                ({occupancy.latitude.toFixed(4)}, {occupancy.longitude.toFixed(4)})
              </li>
            ))}
          </ul>
        )}

        <h2
          style={{
            fontSize: 'var(--boxalarm-font-size-lg)',
            marginTop: 'var(--boxalarm-spacing-lg)',
          }}
        >
          Hydrants
        </h2>
        {hydrantList.length === 0 ? (
          <p>No hydrants in view.</p>
        ) : (
          <ul>
            {hydrantList.map((hydrant) => (
              <li key={hydrant.hydrantId}>
                {hydrant.hydrantId} ({hydrant.latitude.toFixed(4)}, {hydrant.longitude.toFixed(4)})
                —{' '}
                {hydrant.status === 'OUT_OF_SERVICE' ? (
                  <span style={{ color: 'var(--boxalarm-error)' }}>⊘ Out of service</span>
                ) : (
                  <span>● In service</span>
                )}
                <a
                  href={`https://www.openstreetmap.org/?mlat=${hydrant.latitude}&mlon=${hydrant.longitude}#map=18/${hydrant.latitude}/${hydrant.longitude}`}
                  style={{ marginLeft: 'var(--boxalarm-spacing-sm)' }}
                >
                  Open map
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
