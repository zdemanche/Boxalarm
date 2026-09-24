import { FormEvent, Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { Button, Card, PageHeader, Select, Skeleton, TextInput } from '../../components/ui';
import { conductInspection, listDueInspections, scheduleInspection } from './api';
import type { Violation, ViolationStatus } from './types';

const emptyViolation: Violation = { code: '', description: '', status: 'open' };

export function InspectionsPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const canWrite =
    auth.roles.includes('OFFICER') || auth.roles.includes('ADMIN') || auth.roles.includes('CHIEF');
  const [occupancyId, setOccupancyId] = useState('');
  const [scheduledDate, setScheduledDate] = useState('');
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [conductingId, setConductingId] = useState<string | null>(null);
  const [violations, setViolations] = useState<Violation[]>([]);

  const listQuery = useQuery({
    queryKey: ['inspections', 'due'],
    queryFn: () => listDueInspections(auth),
  });

  const scheduleMutation = useMutation({
    mutationFn: () => scheduleInspection(auth, occupancyId, scheduledDate),
    onSuccess: async () => {
      setOccupancyId('');
      setScheduledDate('');
      setScheduleError(null);
      await queryClient.invalidateQueries({ queryKey: ['inspections', 'due'] });
    },
    onError: (error: Error) => setScheduleError(error.message),
  });

  const conductMutation = useMutation({
    mutationFn: (params: { occId: string; inspectionId: string }) =>
      conductInspection(auth, params.occId, params.inspectionId, violations),
    onSuccess: async () => {
      setConductingId(null);
      setViolations([]);
      await queryClient.invalidateQueries({ queryKey: ['inspections', 'due'] });
    },
  });

  if (listQuery.error) {
    return (
      <ApiForbiddenGate error={listQuery.error}>
        <p>Unexpected error</p>
      </ApiForbiddenGate>
    );
  }

  const inspections = listQuery.data ?? [];

  return (
    <main id="main-content">
      <PageHeader title="Inspections" />

      {listQuery.isLoading ? (
        <Skeleton lines={4} />
      ) : (
        <div role="region" aria-label="Inspections due" tabIndex={0} style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <caption className="visually-hidden">Inspections due</caption>
            <thead>
              <tr>
                <th scope="col" style={{ textAlign: 'left' }}>
                  Occupancy
                </th>
                <th scope="col" style={{ textAlign: 'left' }}>
                  Due date
                </th>
                <th scope="col" style={{ textAlign: 'left' }}>
                  Conducted
                </th>
                <th scope="col" style={{ textAlign: 'left' }}>
                  Violations
                </th>
                {canWrite ? (
                  <th scope="col" style={{ textAlign: 'left' }}>
                    Actions
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {inspections.map((inspection) => (
                <Fragment key={inspection.inspectionId}>
                  <tr>
                    <th scope="row" style={{ textAlign: 'left', fontWeight: 500 }}>
                      {inspection.occupancyId}
                    </th>
                    <td>{inspection.nextDueDate}</td>
                    <td>
                      {inspection.conductedDate
                        ? `${inspection.conductedDate} by ${inspection.conductedBy}`
                        : 'Not yet conducted'}
                    </td>
                    <td>
                      {inspection.violations.length === 0
                        ? '—'
                        : inspection.violations.map((v) => `${v.code} (${v.status})`).join(', ')}
                    </td>
                    {canWrite ? (
                      <td>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            setConductingId(inspection.inspectionId);
                            setViolations(
                              inspection.violations.length > 0 ? inspection.violations : [],
                            );
                          }}
                        >
                          Conduct
                        </Button>
                      </td>
                    ) : null}
                  </tr>
                  {conductingId === inspection.inspectionId ? (
                    <tr>
                      <td colSpan={5}>
                        <Card style={{ maxWidth: 640 }}>
                          <form
                            aria-label={`Conduct inspection ${inspection.inspectionId}`}
                            onSubmit={(event: FormEvent) => {
                              event.preventDefault();
                              conductMutation.mutate({
                                occId: inspection.occupancyId,
                                inspectionId: inspection.inspectionId,
                              });
                            }}
                            style={{ display: 'grid', gap: 'var(--bx-space-md)' }}
                          >
                            <fieldset
                              style={{
                                display: 'grid',
                                gap: 'var(--bx-space-sm)',
                                border: 'none',
                                padding: 0,
                              }}
                            >
                              <legend>Violations</legend>
                              {violations.map((violation, index) => (
                                <div
                                  key={index}
                                  style={{ display: 'flex', gap: 'var(--bx-space-sm)' }}
                                >
                                  <TextInput
                                    label="Code"
                                    value={violation.code}
                                    onChange={(e) =>
                                      setViolations((prev) =>
                                        prev.map((v, i) =>
                                          i === index ? { ...v, code: e.target.value } : v,
                                        ),
                                      )
                                    }
                                  />
                                  <TextInput
                                    label="Description"
                                    value={violation.description}
                                    onChange={(e) =>
                                      setViolations((prev) =>
                                        prev.map((v, i) =>
                                          i === index ? { ...v, description: e.target.value } : v,
                                        ),
                                      )
                                    }
                                    style={{ flex: 1 }}
                                  />
                                  <Select
                                    label="Status"
                                    value={violation.status}
                                    onChange={(e) =>
                                      setViolations((prev) =>
                                        prev.map((v, i) =>
                                          i === index
                                            ? { ...v, status: e.target.value as ViolationStatus }
                                            : v,
                                        ),
                                      )
                                    }
                                  >
                                    <option value="open">Open</option>
                                    <option value="resolved">Resolved</option>
                                  </Select>
                                </div>
                              ))}
                              <Button
                                type="button"
                                variant="secondary"
                                onClick={() =>
                                  setViolations((prev) => [...prev, { ...emptyViolation }])
                                }
                              >
                                Add violation
                              </Button>
                            </fieldset>
                            <div style={{ display: 'flex', gap: 'var(--bx-space-sm)' }}>
                              <Button type="submit" loading={conductMutation.isPending}>
                                Save conduct
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                onClick={() => setConductingId(null)}
                              >
                                Cancel
                              </Button>
                            </div>
                          </form>
                        </Card>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canWrite ? (
        <Card
          title="Schedule inspection"
          style={{ marginTop: 'var(--bx-space-xl)', maxWidth: 480 }}
        >
          <form
            aria-label="Schedule inspection"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              scheduleMutation.mutate();
            }}
            style={{ display: 'grid', gap: 'var(--bx-space-md)' }}
          >
            <TextInput
              label="Occupancy ID"
              value={occupancyId}
              required
              onChange={(e) => setOccupancyId(e.target.value)}
            />
            <TextInput
              label="Scheduled date"
              type="date"
              value={scheduledDate}
              required
              onChange={(e) => setScheduledDate(e.target.value)}
            />
            {scheduleError ? (
              <p role="alert" aria-live="assertive">
                {scheduleError}
              </p>
            ) : null}
            <Button type="submit" loading={scheduleMutation.isPending}>
              Schedule
            </Button>
          </form>
        </Card>
      ) : null}
    </main>
  );
}
