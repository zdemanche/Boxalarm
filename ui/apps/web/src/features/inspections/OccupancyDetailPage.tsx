import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { getOccupancy, getPrePlan, putPrePlan, updateOccupancy, uploadPrePlanFile } from './api';
import type { UtilityShutoff } from './types';

type Tab = 'details' | 'preplan';

function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function OccupancyDetailPage() {
  const { id = '' } = useParams();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const canWrite = auth.roles.includes('ADMIN') || auth.roles.includes('CHIEF');
  const [tab, setTab] = useState<Tab>('details');
  const [hazardsText, setHazardsText] = useState('');
  const [diagramFile, setDiagramFile] = useState<File | null>(null);
  const [attachmentFiles, setAttachmentFiles] = useState<File[]>([]);
  const [shutoffs, setShutoffs] = useState<UtilityShutoff[]>([]);
  const [prePlanHazardsText, setPrePlanHazardsText] = useState('');
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);

  const occupancyQuery = useQuery({
    queryKey: ['inspections', 'occupancies', id],
    queryFn: () => getOccupancy(auth, id),
    enabled: Boolean(id),
  });

  const prePlanQuery = useQuery({
    queryKey: ['inspections', 'preplan', id],
    queryFn: () => getPrePlan(auth, id),
    enabled: Boolean(id) && tab === 'preplan',
  });

  const hazardsMutation = useMutation({
    mutationFn: () => updateOccupancy(auth, id, { hazards: splitLines(hazardsText) }),
    onSuccess: (occupancy) => {
      queryClient.setQueryData(['inspections', 'occupancies', id], occupancy);
    },
  });

  const prePlanMutation = useMutation({
    mutationFn: async () => {
      const result = await putPrePlan(auth, id, {
        ...(diagramFile ? { siteDiagramFilename: diagramFile.name } : {}),
        attachmentFilenames: attachmentFiles.map((file) => file.name),
        utilityShutoffs: shutoffs,
        hazards: splitLines(prePlanHazardsText),
      });
      if (diagramFile && result.siteDiagramUploadUrl) {
        await uploadPrePlanFile(result.siteDiagramUploadUrl, diagramFile);
      }
      for (const attachment of result.attachmentUploadUrls) {
        const file = attachmentFiles.find((f) => f.name === attachment.filename);
        if (file) await uploadPrePlanFile(attachment.uploadUrl, file);
      }
      return result;
    },
    onSuccess: async () => {
      setUploadStatus('Pre-plan saved.');
      setDiagramFile(null);
      setAttachmentFiles([]);
      await queryClient.invalidateQueries({ queryKey: ['inspections', 'preplan', id] });
    },
  });

  if (occupancyQuery.error) {
    return (
      <ApiForbiddenGate error={occupancyQuery.error}>
        <p>Unexpected error</p>
      </ApiForbiddenGate>
    );
  }

  const occupancy = occupancyQuery.data;

  return (
    <main id="main-content" style={{ padding: 'var(--boxalarm-spacing-lg)' }}>
      <p>
        <Link to="/inspections/occupancies">← Occupancies</Link>
      </p>
      {occupancyQuery.isLoading || !occupancy ? (
        <p>Loading occupancy…</p>
      ) : (
        <>
          <h1 style={{ fontSize: 'var(--boxalarm-font-size-xl)', margin: 0 }}>
            {occupancy.address}
          </h1>

          <div
            role="tablist"
            aria-label="Occupancy sections"
            style={{
              display: 'flex',
              gap: 'var(--boxalarm-spacing-sm)',
              marginTop: 'var(--boxalarm-spacing-lg)',
            }}
          >
            {(['details', 'preplan'] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                onClick={() => setTab(value)}
                style={{
                  minHeight: 44,
                  padding: '0 var(--boxalarm-spacing-md)',
                  fontWeight: tab === value ? 700 : 400,
                }}
              >
                {value === 'details' ? 'Details' : 'Pre-plan'}
              </button>
            ))}
          </div>

          {tab === 'details' ? (
            <section role="tabpanel" aria-label="Details">
              <dl style={{ marginTop: 'var(--boxalarm-spacing-lg)' }}>
                <dt>Type</dt>
                <dd>{occupancy.occupancyType}</dd>
                <dt>Contacts</dt>
                <dd>
                  {occupancy.contacts.length > 0
                    ? occupancy.contacts.map((c) => `${c.name} (${c.role}) ${c.phone}`).join('; ')
                    : '—'}
                </dd>
                <dt>Hazards</dt>
                <dd>{occupancy.hazards.length > 0 ? occupancy.hazards.join(', ') : '—'}</dd>
              </dl>

              {canWrite ? (
                <form
                  aria-label="Edit hazards"
                  onSubmit={(event: FormEvent) => {
                    event.preventDefault();
                    hazardsMutation.mutate();
                  }}
                  style={{
                    marginTop: 'var(--boxalarm-spacing-xl)',
                    display: 'grid',
                    gap: 'var(--boxalarm-spacing-md)',
                    maxWidth: 480,
                  }}
                >
                  <h2 style={{ fontSize: 'var(--boxalarm-font-size-lg)', margin: 0 }}>
                    Edit hazards
                  </h2>
                  <label style={{ display: 'grid', gap: 4 }}>
                    Hazards (one per line)
                    <textarea
                      value={hazardsText}
                      onChange={(e) => setHazardsText(e.target.value)}
                      style={{ minHeight: 88, padding: 8 }}
                    />
                  </label>
                  <button type="submit" style={{ minHeight: 44 }}>
                    Save hazards
                  </button>
                </form>
              ) : null}

              {hazardsMutation.error ? (
                <ApiForbiddenGate error={hazardsMutation.error} embedded>
                  <p role="alert">Unable to save changes</p>
                </ApiForbiddenGate>
              ) : null}
            </section>
          ) : (
            <section role="tabpanel" aria-label="Pre-plan">
              {prePlanQuery.isLoading ? (
                <p>Loading pre-plan…</p>
              ) : prePlanQuery.data ? (
                <dl style={{ marginTop: 'var(--boxalarm-spacing-lg)' }}>
                  <dt>Site diagram</dt>
                  <dd>
                    {prePlanQuery.data.siteDiagramUrl ? (
                      <a href={prePlanQuery.data.siteDiagramUrl}>View diagram</a>
                    ) : (
                      '—'
                    )}
                  </dd>
                  <dt>Attachments</dt>
                  <dd>
                    {prePlanQuery.data.attachmentUrls.length > 0 ? (
                      <ul>
                        {prePlanQuery.data.attachmentUrls.map((a) => (
                          <li key={a.key}>
                            <a href={a.url}>{a.key}</a>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      '—'
                    )}
                  </dd>
                  <dt>Utility shutoffs</dt>
                  <dd>
                    {prePlanQuery.data.utilityShutoffs.length > 0
                      ? prePlanQuery.data.utilityShutoffs
                          .map((s) => `${s.utility}: ${s.location}`)
                          .join('; ')
                      : '—'}
                  </dd>
                  <dt>Hazards</dt>
                  <dd>
                    {prePlanQuery.data.hazards.length > 0
                      ? prePlanQuery.data.hazards.join(', ')
                      : '—'}
                  </dd>
                </dl>
              ) : (
                <p>No pre-plan is on file.</p>
              )}

              {canWrite ? (
                <form
                  aria-label="Save pre-plan"
                  onSubmit={(event: FormEvent) => {
                    event.preventDefault();
                    setUploadStatus(null);
                    prePlanMutation.mutate();
                  }}
                  style={{
                    marginTop: 'var(--boxalarm-spacing-xl)',
                    display: 'grid',
                    gap: 'var(--boxalarm-spacing-md)',
                    maxWidth: 480,
                  }}
                >
                  <h2 style={{ fontSize: 'var(--boxalarm-font-size-lg)', margin: 0 }}>
                    Update pre-plan
                  </h2>
                  <label style={{ display: 'grid', gap: 4 }}>
                    Site diagram
                    <input
                      type="file"
                      onChange={(e) => setDiagramFile(e.target.files?.[0] ?? null)}
                    />
                  </label>
                  <label style={{ display: 'grid', gap: 4 }}>
                    Attachments
                    <input
                      type="file"
                      multiple
                      onChange={(e) => setAttachmentFiles(Array.from(e.target.files ?? []))}
                    />
                  </label>
                  <fieldset style={{ display: 'grid', gap: 'var(--boxalarm-spacing-sm)' }}>
                    <legend>Utility shutoffs</legend>
                    {shutoffs.map((shutoff, index) => (
                      <div
                        key={index}
                        style={{ display: 'flex', gap: 'var(--boxalarm-spacing-sm)' }}
                      >
                        <label style={{ display: 'grid', gap: 4, flex: 1 }}>
                          Utility
                          <input
                            value={shutoff.utility}
                            onChange={(e) =>
                              setShutoffs((prev) =>
                                prev.map((s, i) =>
                                  i === index ? { ...s, utility: e.target.value } : s,
                                ),
                              )
                            }
                            style={{ minHeight: 44, padding: '0 12px' }}
                          />
                        </label>
                        <label style={{ display: 'grid', gap: 4, flex: 1 }}>
                          Location
                          <input
                            value={shutoff.location}
                            onChange={(e) =>
                              setShutoffs((prev) =>
                                prev.map((s, i) =>
                                  i === index ? { ...s, location: e.target.value } : s,
                                ),
                              )
                            }
                            style={{ minHeight: 44, padding: '0 12px' }}
                          />
                        </label>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() =>
                        setShutoffs((prev) => [...prev, { utility: '', location: '' }])
                      }
                      style={{ minHeight: 44 }}
                    >
                      Add shutoff
                    </button>
                  </fieldset>
                  <label style={{ display: 'grid', gap: 4 }}>
                    Hazards (one per line)
                    <textarea
                      value={prePlanHazardsText}
                      onChange={(e) => setPrePlanHazardsText(e.target.value)}
                      style={{ minHeight: 88, padding: 8 }}
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={prePlanMutation.isPending}
                    style={{ minHeight: 44 }}
                  >
                    Save pre-plan
                  </button>
                  <p role="status" aria-live="polite">
                    {uploadStatus}
                  </p>
                </form>
              ) : null}

              {prePlanMutation.error ? (
                <ApiForbiddenGate error={prePlanMutation.error} embedded>
                  <p role="alert">Unable to save pre-plan</p>
                </ApiForbiddenGate>
              ) : null}
            </section>
          )}
        </>
      )}
    </main>
  );
}
