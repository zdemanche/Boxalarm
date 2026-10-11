import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { Button, Card, PageHeader, StatusChip, Tabs, buttonClassName } from '../../components/ui';
import { canAccessPath } from '../../routing/routeTable';
import { listOccupancies, queryMap } from './api';
import { leafletMapProvider } from './leafletMapProvider';
import { mergeHydrants, mergeOccupancies, panBoundingBox, zoomBoundingBox } from './mapProvider';
import type { BoundingBox, MapHydrant, MapOccupancy } from './types';
import styles from './Inspections.module.css';

const NICHOLS_FD_CENTER: BoundingBox = {
  minLat: 41.23,
  minLng: -73.21,
  maxLat: 41.27,
  maxLng: -73.17,
};

function coordinates(latitude: number, longitude: number): string {
  return `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
}

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
  // The map feed carries ids and coordinates only; the registry (same query the Occupancies and
  // Inspections pages share) names each pin by its address. Without it the list falls back to ids.
  const registryQuery = useQuery({
    queryKey: ['inspections', 'occupancies'],
    queryFn: () => listOccupancies(auth),
    enabled: canAccessPath('/inspections/occupancies', auth.roles),
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
  const registered = (id: string) => registryQuery.data?.find((o) => o.occupancyId === id);
  const MapView = leafletMapProvider.MapView;

  return (
    <main id="main-content">
      <PageHeader
        title="Map"
        description="Occupancies and hydrants in the district. Every pin on the map is also in the lists."
      />

      <div className={styles.layout}>
        <Card className={styles.mapCard}>
          <div role="group" aria-label="Pan and zoom" className={styles.mapControls}>
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
                  <div className={styles.mapFrame}>
                    <MapView
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
                  <p className={styles.message}>
                    Every occupancy and hydrant on the map is in the Occupancies and Hydrants lists,
                    with its coordinates and status.
                  </p>
                ),
              },
            ]}
          />
        </Card>

        <div className={styles.stack}>
          <Card title="Occupancies">
            {occupancyList.length === 0 ? (
              <p className={styles.message}>No occupancies in view.</p>
            ) : (
              <ul className={styles.list}>
                {occupancyList.map((occupancy) => {
                  const record = registered(occupancy.occupancyId);
                  return (
                    <li key={occupancy.occupancyId} className={styles.row}>
                      <span className={styles.rowBody}>
                        <Link
                          to={`/inspections/occupancies/${occupancy.occupancyId}`}
                          className={styles.rowTitle}
                        >
                          {record?.address ?? occupancy.occupancyId}
                        </Link>
                        <span className={styles.rowMeta}>
                          {record ? `${record.occupancyType} · ` : ''}
                          {coordinates(occupancy.latitude, occupancy.longitude)}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card title="Hydrants">
            {hydrantList.length === 0 ? (
              <p className={styles.message}>No hydrants in view.</p>
            ) : (
              <ul className={styles.list}>
                {hydrantList.map((hydrant) => (
                  <li key={hydrant.hydrantId} className={styles.row}>
                    <span className={styles.rowBody}>
                      <span className={[styles.rowTitle, styles.mono].join(' ')}>
                        {hydrant.hydrantId}
                      </span>
                      <span className={styles.rowMeta}>
                        {coordinates(hydrant.latitude, hydrant.longitude)}
                      </span>
                    </span>
                    <span className={styles.rowAside}>
                      <StatusChip status={hydrant.status === 'OUT_OF_SERVICE' ? 'danger' : 'ok'}>
                        {hydrant.status === 'OUT_OF_SERVICE' ? 'Out of service' : 'In service'}
                      </StatusChip>
                      <a
                        href={`https://www.openstreetmap.org/?mlat=${hydrant.latitude}&mlon=${hydrant.longitude}#map=18/${hydrant.latitude}/${hydrant.longitude}`}
                        className={buttonClassName({ variant: 'secondary', size: 'sm' })}
                        aria-label={`Open map for ${hydrant.hydrantId}`}
                      >
                        Open map
                      </a>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </main>
  );
}
