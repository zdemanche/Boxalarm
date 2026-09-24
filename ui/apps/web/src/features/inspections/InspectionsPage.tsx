import { FormEvent, Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
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
    <main id="main-content" style={{ padding: 'var(--boxalarm-spacing-lg)' }}>
      <h1 style={{ fontSize: 'var(--boxalarm-font-size-xl)', margin: 0 }}>Inspections</h1>

      {listQuery.isLoading ? (
        <p>Loading inspections…</p>
      ) : (
        <table
          style={{
            width: '100%',
            marginTop: 'var(--boxalarm-spacing-lg)',
            borderCollapse: 'collapse',
          }}
        >
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
                      <button
                        type="button"
                        onClick={() => {
                          setConductingId(inspection.inspectionId);
                          setViolations(
                            inspection.violations.length > 0 ? inspection.violations : [],
                          );
                        }}
                        style={{ minHeight: 44 }}
                      >
                        Conduct
                      </button>
                    </td>
                  ) : null}
                </tr>
                {conductingId === inspection.inspectionId ? (
                  <tr>
                    <td colSpan={5}>
                      <form
                        aria-label={`Conduct inspection ${inspection.inspectionId}`}
                        onSubmit={(event: FormEvent) => {
                          event.preventDefault();
                          conductMutation.mutate({
                            occId: inspection.occupancyId,
                            inspectionId: inspection.inspectionId,
                          });
                        }}
                        style={{
                          display: 'grid',
                          gap: 'var(--boxalarm-spacing-md)',
                          padding: 'var(--boxalarm-spacing-md)',
                          maxWidth: 640,
                        }}
                      >
                        <fieldset style={{ display: 'grid', gap: 'var(--boxalarm-spacing-sm)' }}>
                          <legend>Violations</legend>
                          {violations.map((violation, index) => (
                            <div
                              key={index}
                              style={{ display: 'flex', gap: 'var(--boxalarm-spacing-sm)' }}
                            >
                              <label style={{ display: 'grid', gap: 4 }}>
                                Code
                                <input
                                  value={violation.code}
                                  onChange={(e) =>
                                    setViolations((prev) =>
                                      prev.map((v, i) =>
                                        i === index ? { ...v, code: e.target.value } : v,
                                      ),
                                    )
                                  }
                                  style={{ minHeight: 44, padding: '0 12px' }}
                                />
                              </label>
                              <label style={{ display: 'grid', gap: 4, flex: 1 }}>
                                Description
                                <input
                                  value={violation.description}
                                  onChange={(e) =>
                                    setViolations((prev) =>
                                      prev.map((v, i) =>
                                        i === index ? { ...v, description: e.target.value } : v,
                                      ),
                                    )
                                  }
                                  style={{ minHeight: 44, padding: '0 12px' }}
                                />
                              </label>
                              <label style={{ display: 'grid', gap: 4 }}>
                                Status
                                <select
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
                                  style={{ minHeight: 44 }}
                                >
                                  <option value="open">Open</option>
                                  <option value="resolved">Resolved</option>
                                </select>
                              </label>
                            </div>
                          ))}
                          <button
                            type="button"
                            onClick={() =>
                              setViolations((prev) => [...prev, { ...emptyViolation }])
                            }
                            style={{ minHeight: 44 }}
                          >
                            Add violation
                          </button>
                        </fieldset>
                        <div style={{ display: 'flex', gap: 'var(--boxalarm-spacing-sm)' }}>
                          <button type="submit" style={{ minHeight: 44 }}>
                            Save conduct
                          </button>
                          <button
                            type="button"
                            onClick={() => setConductingId(null)}
                            style={{ minHeight: 44 }}
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}

      {canWrite ? (
        <form
          aria-label="Schedule inspection"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            scheduleMutation.mutate();
          }}
          style={{
            marginTop: 'var(--boxalarm-spacing-xl)',
            display: 'grid',
            gap: 'var(--boxalarm-spacing-md)',
            maxWidth: 480,
          }}
        >
          <h2 style={{ fontSize: 'var(--boxalarm-font-size-lg)', margin: 0 }}>
            Schedule inspection
          </h2>
          <label style={{ display: 'grid', gap: 4 }}>
            Occupancy ID
            <input
              value={occupancyId}
              required
              onChange={(e) => setOccupancyId(e.target.value)}
              style={{ minHeight: 44, padding: '0 12px' }}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            Scheduled date
            <input
              type="date"
              value={scheduledDate}
              required
              onChange={(e) => setScheduledDate(e.target.value)}
              style={{ minHeight: 44, padding: '0 12px' }}
            />
          </label>
          {scheduleError ? (
            <p role="alert" aria-live="assertive">
              {scheduleError}
            </p>
          ) : null}
          <button type="submit" style={{ minHeight: 44 }}>
            Schedule
          </button>
        </form>
      ) : null}
    </main>
  );
}
