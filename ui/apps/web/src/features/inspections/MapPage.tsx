import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { Button, Card, PageHeader, Tabs } from '../../components/ui';
import { LeafletMap } from './LeafletMap';
import { queryMap } from './api';
import { mergeHydrants, mergeOccupancies, panBoundingBox, zoomBoundingBox } from './mapProvider';
import type { BoundingBox, MapHydrant, MapOccupancy } from './types';

const NICHOLS_FD_CENTER: BoundingBox = {
  minLat: 41.23,
  minLng: -73.21,
  maxLat: 41.27,
  maxLng: -73.17,
};

export function MapPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [bbox, setBbox] = useState<BoundingBox>(NICHOLS_FD_CENTER);
  const [occupancies, setOccupancies] = useState<Map<string, MapOccupancy>>(new Map());
  const [hydrants, setHydrants] = useState<Map<string, MapHydrant>>(new Map());

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
    <main id="main-content">
      <PageHeader title="Map" />

      <div
        role="group"
        aria-label="Pan and zoom"
        style={{ display: 'flex', gap: 'var(--bx-space-sm)' }}
      >
        <Button type="button" variant="secondary" onClick={() => pan(latSpan * 0.5, 0)}>
          Pan north
        </Button>
        <Button type="button" variant="secondary" onClick={() => pan(-latSpan * 0.5, 0)}>
          Pan south
        </Button>
        <Button type="button" variant="secondary" onClick={() => pan(0, -lngSpan * 0.5)}>
          Pan west
        </Button>
        <Button type="button" variant="secondary" onClick={() => pan(0, lngSpan * 0.5)}>
          Pan east
        </Button>
        <Button type="button" variant="secondary" onClick={() => zoom(0.5)}>
          Zoom in
        </Button>
        <Button type="button" variant="secondary" onClick={() => zoom(2)}>
          Zoom out
        </Button>
      </div>

      <Tabs
        label="Map display"
        items={[
          {
            value: 'map',
            label: 'Map view',
            content: (
              <div style={{ marginTop: 'var(--bx-space-md)' }}>
                <LeafletMap
                  bbox={bbox}
                  occupancies={occupancyList}
                  hydrants={hydrantList}
                  onOccupancySelect={(occupancyId) =>
                    navigate(`/inspections/occupancies/${occupancyId}`)
                  }
                />
              </div>
            ),
          },
          {
            value: 'list',
            label: 'List view',
            content: (
              <p style={{ marginTop: 'var(--bx-space-md)' }}>
                See the accessible occupancy and hydrant lists below.
              </p>
            ),
          },
        ]}
      />

      <Card title="Occupancies" style={{ marginTop: 'var(--bx-space-lg)' }}>
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
      </Card>

      <Card title="Hydrants" style={{ marginTop: 'var(--bx-space-lg)' }}>
        {hydrantList.length === 0 ? (
          <p>No hydrants in view.</p>
        ) : (
          <ul>
            {hydrantList.map((hydrant) => (
              <li key={hydrant.hydrantId}>
                {hydrant.hydrantId} ({hydrant.latitude.toFixed(4)}, {hydrant.longitude.toFixed(4)})
                —{' '}
                {hydrant.status === 'OUT_OF_SERVICE' ? (
                  <span style={{ color: 'var(--bx-status-danger)' }}>⊘ Out of service</span>
                ) : (
                  <span>● In service</span>
                )}
                <a
                  href={`https://www.openstreetmap.org/?mlat=${hydrant.latitude}&mlon=${hydrant.longitude}#map=18/${hydrant.latitude}/${hydrant.longitude}`}
                  style={{ marginLeft: 'var(--bx-space-sm)' }}
                >
                  Open map
                </a>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </main>
  );
}
