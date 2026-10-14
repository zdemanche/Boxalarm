import type { StatusRole } from '@boxalarm/design-tokens';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { Card, PageHeader, Skeleton, StatusChip, Tabs } from '../../components/ui';
import { formatCalendarDate, toCalendarDate } from '../../lib/dates';
import { listEquipment } from '../inventory/api';
import { getApparatus } from './api';
import { InventoryTab } from './InventoryTab';
import { MaintenanceTab } from './MaintenanceTab';
import { ScbaTab } from './ScbaTab';
import { ResolveDefectControl, resolveWarningFor } from './ResolveDefectControl';
import { ServiceStatusControls } from './ServiceStatusControls';
import { serviceStatusRole } from './StatusBadge';
import { TestingTab } from './TestingTab';
import type { OpenDefectSummary } from './types';
import styles from './Apparatus.module.css';

const SEVERITY_WORD: Record<OpenDefectSummary['severity'], string> = {
  MINOR: 'Minor',
  MAJOR: 'Major',
  OUT_OF_SERVICE: 'Out of service',
};

const SEVERITY_STATUS: Record<OpenDefectSummary['severity'], StatusRole> = {
  MINOR: 'warning',
  MAJOR: 'caution',
  OUT_OF_SERVICE: 'danger',
};

/** A signed http(s) URL or a same-origin path. An S3 key is not a displayable photo. */
export function defectPhotoSrc(defect: OpenDefectSummary): string | null {
  const candidate = defect.photoUrl?.trim();
  if (!candidate) return null;
  if (candidate.startsWith('/') && !candidate.startsWith('//')) return candidate;
  try {
    const url = new URL(candidate);
    if (url.protocol === 'https:' || url.protocol === 'http:') return candidate;
  } catch {
    return null;
  }
  return null;
}

export function ApparatusDetailPage() {
  // The route param is the display unitId: the backend resolves GET /apparatus/{unitId} by
  // unitId (apparatus-service getApparatus.ts -> getApparatusByUnitId), not by apparatusId.
  const { id = '' } = useParams();
  const auth = useAuth();
  // Survives the resolved defect leaving the list: resolving never returns the unit to service.
  const [resolveWarning, setResolveWarning] = useState<string | null>(null);

  const detailQuery = useQuery({
    queryKey: ['apparatus', id],
    queryFn: () => getApparatus(auth, id),
    enabled: Boolean(id),
  });

  const apparatusId = detailQuery.data?.apparatusId ?? '';
  const equipmentQuery = useQuery({
    queryKey: ['inventory', 'equipment', 'byApparatus', apparatusId],
    queryFn: () => listEquipment(auth, { assignedToType: 'APPARATUS', assignedToId: apparatusId }),
    enabled: Boolean(apparatusId),
  });

  if (detailQuery.error) {
    return (
      <ApiForbiddenGate error={detailQuery.error}>
        <p>Unexpected error</p>
      </ApiForbiddenGate>
    );
  }

  const unit = detailQuery.data;
  const equipment = equipmentQuery.data ?? [];

  return (
    <main id="main-content">
      <PageHeader
        title={unit?.unitId ?? '…'}
        breadcrumbs={[{ label: 'Apparatus', to: '/apparatus' }, { label: unit?.unitId ?? '…' }]}
        description={
          unit ? (
            <span className={styles.headerMeta}>
              {/* The unit's one status chip: a change made in Service status is announced here. */}
              <span role="status">
                <StatusChip status={serviceStatusRole(unit.status)}>
                  {unit.status === 'IN_SERVICE' ? 'In service' : 'Out of service'}
                </StatusChip>
              </span>
              <span>{unit.type}</span>
              <span>
                ID <span className={styles.mono}>{unit.apparatusId}</span>
              </span>
            </span>
          ) : undefined
        }
      />
      {detailQuery.isLoading || !unit ? (
        <Card>
          <Skeleton lines={3} />
        </Card>
      ) : (
        <div className={styles.detailGrid}>
          <Card title="Open defects">
            {resolveWarning ? (
              <p role="status" className={styles.notice}>
                {resolveWarning}
              </p>
            ) : null}
            {unit.openDefects.length === 0 ? (
              <p className={styles.message}>No open defects.</p>
            ) : (
              <ul className={styles.list}>
                {unit.openDefects.map((defect) => {
                  const photo = defectPhotoSrc(defect);
                  const reportedMs = defect.reportedAt * 1000;
                  return (
                    <li key={defect.defectId} className={styles.row}>
                      {photo ? (
                        <img
                          src={photo}
                          alt={defect.description}
                          width={96}
                          height={72}
                          className={styles.defectPhoto}
                        />
                      ) : null}
                      <div className={styles.rowBody}>
                        <strong className={styles.rowTitle}>{defect.description}</strong>
                        <div className={styles.metaLine}>
                          <StatusChip status={SEVERITY_STATUS[defect.severity]}>
                            {SEVERITY_WORD[defect.severity]}
                          </StatusChip>
                          <span className={styles.rowMeta}>
                            Reported{' '}
                            <time dateTime={new Date(reportedMs).toISOString()}>
                              {formatCalendarDate(toCalendarDate(reportedMs))}
                            </time>
                          </span>
                        </div>
                        {photo ? null : defect.photoS3Key ? (
                          <span className={styles.rowMeta}>
                            Photo on file. The apparatus record did not include a signed photo URL.
                          </span>
                        ) : (
                          <span className={styles.rowMeta}>No photo.</span>
                        )}
                      </div>
                      <div className={styles.rowAside}>
                        <ResolveDefectControl
                          unitId={unit.unitId}
                          defectId={defect.defectId}
                          description={defect.description}
                          onResolved={(result) =>
                            setResolveWarning(resolveWarningFor(unit.unitId, result))
                          }
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <div className={styles.detailSide}>
            <ServiceStatusControls unit={unit} />

            <Card title="Assigned equipment">
              {equipmentQuery.isLoading ? (
                <Skeleton lines={2} />
              ) : equipment.length === 0 ? (
                <p className={styles.message}>No equipment assigned.</p>
              ) : (
                <ul className={styles.list}>
                  {equipment.map((asset) => (
                    <li key={asset.assetId} className={styles.row}>
                      <span className={styles.rowBody}>
                        <Link
                          to={`/inventory/${asset.assetId}`}
                          className={[styles.rowTitle, styles.mono].join(' ')}
                        >
                          {asset.serialNumber}
                        </Link>
                        {asset.location ? (
                          <span className={styles.rowMeta}>{asset.location}</span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <div className={styles.detailRecords}>
            <Tabs
              label="Apparatus detail sections"
              items={[
                {
                  value: 'maintenance',
                  label: 'Maintenance',
                  content: <MaintenanceTab apparatusId={unit.apparatusId} />,
                },
                {
                  // POST /{unitId}/scba resolves the unit by unitId; the due-soon feed carries the
                  // resolved apparatusId, so the tab needs both.
                  value: 'scba',
                  label: 'SCBA',
                  content: <ScbaTab unitId={unit.unitId} apparatusId={unit.apparatusId} />,
                },
                {
                  // Testing schedules are the one sub-resource the backend resolves and returns by
                  // display unit code, so it alone still takes unitId — see the tab-identifier note
                  // in the apparatus-service INFRA reconciliation ticket for the full picture.
                  value: 'testing',
                  label: 'Testing',
                  content: <TestingTab unitId={unit.unitId} />,
                },
                {
                  value: 'inventory',
                  label: 'Inventory',
                  content: <InventoryTab apparatusId={unit.apparatusId} />,
                },
              ]}
            />
          </div>
        </div>
      )}
    </main>
  );
}
