import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { Button, Card, PageHeader, Skeleton, Tabs, Textarea, TextInput } from '../../components/ui';
import { getOccupancy, getPrePlan, putPrePlan, updateOccupancy, uploadPrePlanFile } from './api';
import type { UtilityShutoff } from './types';
import styles from './Inspections.module.css';

type Tab = 'details' | 'preplan';

/** Site diagrams and supporting attachments only — the file types a pre-plan needs. */
const PREPLAN_FILE_ACCEPT = '.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg';
const MAX_PREPLAN_FILE_BYTES = 20 * 1024 * 1024; // 20MB — generous for a scanned floor plan/photo

function oversizedFileNames(files: File[]): string[] {
  return files.filter((file) => file.size > MAX_PREPLAN_FILE_BYTES).map((file) => file.name);
}

/** putPrePlanHandler's MAX_LIST_LENGTH for attachmentFilenames. */
const MAX_PREPLAN_ATTACHMENTS = 50;

/** Stored asset keys end in the uploaded file's name: `{dept}/PRE_PLAN/{prePlanId}/{filename}`. */
function fileNameOf(key: string): string {
  return key.slice(key.lastIndexOf('/') + 1);
}

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
  // Both saves replace whole lists, so each editor shows what is on file until it is edited
  // (null = untouched). An editor that opened empty deleted every existing hazard and shutoff
  // the first time someone added one.
  const [hazardsDraft, setHazardsDraft] = useState<string | null>(null);
  const [diagramFile, setDiagramFile] = useState<File | null>(null);
  const [attachmentFiles, setAttachmentFiles] = useState<File[]>([]);
  const [shutoffsDraft, setShutoffsDraft] = useState<UtilityShutoff[] | null>(null);
  const [prePlanHazardsDraft, setPrePlanHazardsDraft] = useState<string | null>(null);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

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

  const hazardsText = hazardsDraft ?? occupancyQuery.data?.hazards.join('\n') ?? '';
  const shutoffs = shutoffsDraft ?? prePlanQuery.data?.utilityShutoffs ?? [];
  const setShutoffs = (update: (prev: UtilityShutoff[]) => UtilityShutoff[]) =>
    setShutoffsDraft(update(shutoffs));
  const prePlanHazardsText = prePlanHazardsDraft ?? prePlanQuery.data?.hazards.join('\n') ?? '';

  const hazardsMutation = useMutation({
    mutationFn: () => updateOccupancy(auth, id, { hazards: splitLines(hazardsText) }),
    onSuccess: (occupancy) => {
      queryClient.setQueryData(['inspections', 'occupancies', id], occupancy);
      setHazardsDraft(null);
    },
  });

  const prePlanMutation = useMutation({
    mutationFn: async () => {
      // The PUT replaces the whole pre-plan, so files already on file are named again (same
      // pre-plan id, same key) or the save would drop them. Only new files are uploaded below.
      const onFile = prePlanQuery.data;
      const diagramOnFile = onFile?.siteDiagramS3Key ? fileNameOf(onFile.siteDiagramS3Key) : null;
      const newNames = attachmentFiles.map((file) => file.name);
      const keptAttachments = (onFile?.attachmentS3Keys ?? [])
        .map(fileNameOf)
        .filter((name) => !newNames.includes(name));
      const siteDiagramFilename = diagramFile?.name ?? diagramOnFile;
      const result = await putPrePlan(auth, id, {
        ...(siteDiagramFilename ? { siteDiagramFilename } : {}),
        attachmentFilenames: [...keptAttachments, ...newNames],
        utilityShutoffs: shutoffs,
        hazards: splitLines(prePlanHazardsText),
      });
      if (diagramFile && result.siteDiagramUploadUrl) {
        await uploadPrePlanFile(
          result.siteDiagramUploadUrl,
          diagramFile,
          result.siteDiagramContentType,
        );
      }
      for (const attachment of result.attachmentUploadUrls) {
        const file = attachmentFiles.find((f) => f.name === attachment.filename);
        if (file) await uploadPrePlanFile(attachment.uploadUrl, file, attachment.contentType);
      }
      return result;
    },
    onSuccess: async () => {
      setUploadStatus('Pre-plan saved.');
      setDiagramFile(null);
      setAttachmentFiles([]);
      await queryClient.invalidateQueries({ queryKey: ['inspections', 'preplan', id] });
      setShutoffsDraft(null);
      setPrePlanHazardsDraft(null);
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

  const detailsSide = canWrite || Boolean(hazardsMutation.error);
  const detailsPanel = occupancy ? (
    <div className={detailsSide ? styles.layout : styles.stack}>
      <Card title="Occupancy details">
        <dl className={styles.facts}>
          <dt>Type</dt>
          <dd>{occupancy.occupancyType}</dd>
          <dt>Contacts</dt>
          <dd>
            {occupancy.contacts.length > 0 ? (
              <ul>
                {occupancy.contacts.map((c) => (
                  <li key={`${c.name}-${c.phone}`}>{`${c.name} (${c.role}) ${c.phone}`}</li>
                ))}
              </ul>
            ) : (
              '—'
            )}
          </dd>
          <dt>Hazards</dt>
          <dd>{occupancy.hazards.length > 0 ? occupancy.hazards.join(', ') : '—'}</dd>
        </dl>
      </Card>

      {detailsSide ? (
        <div className={styles.stack}>
          {canWrite ? (
            <Card title="Edit hazards">
              <form
                aria-label="Edit hazards"
                onSubmit={(event: FormEvent) => {
                  event.preventDefault();
                  hazardsMutation.mutate();
                }}
                className={styles.formStack}
              >
                <Textarea
                  label="Hazards (one per line)"
                  value={hazardsText}
                  onChange={(e) => setHazardsDraft(e.target.value)}
                />
                <div className={styles.formActions}>
                  <Button type="submit" loading={hazardsMutation.isPending}>
                    Save hazards
                  </Button>
                </div>
              </form>
            </Card>
          ) : null}

          {hazardsMutation.error ? (
            <ApiForbiddenGate error={hazardsMutation.error} embedded>
              <p role="alert">Unable to save changes</p>
            </ApiForbiddenGate>
          ) : null}
        </div>
      ) : null}
    </div>
  ) : null;

  // Every stored file is `{prePlanId}/{name}`: a new attachment named like the diagram would
  // overwrite it, and the service accepts at most 50 attachments per save.
  function prePlanFileProblem(): string | null {
    const onFile = prePlanQuery.data;
    const diagramName =
      diagramFile?.name ?? (onFile?.siteDiagramS3Key ? fileNameOf(onFile.siteDiagramS3Key) : null);
    const clash = attachmentFiles.find((file) => file.name === diagramName);
    if (clash) {
      return `${clash.name} has the same name as the site diagram. Rename one of them before saving.`;
    }
    const newNames = attachmentFiles.map((file) => file.name);
    const kept = (onFile?.attachmentS3Keys ?? [])
      .map(fileNameOf)
      .filter((name) => !newNames.includes(name));
    if (kept.length + newNames.length > MAX_PREPLAN_ATTACHMENTS) {
      return `A pre-plan holds at most ${MAX_PREPLAN_ATTACHMENTS} attachments; this save would have ${kept.length + newNames.length}.`;
    }
    return null;
  }

  // Success includes a 404 (no pre-plan yet), which the client maps to null.
  const showPrePlanEditor = canWrite && prePlanQuery.isSuccess;
  const prePlanSide = showPrePlanEditor || Boolean(prePlanMutation.error);
  const prePlanPanel = (
    <div className={prePlanSide ? styles.layout : styles.stack}>
      <Card title="Pre-plan on file">
        {prePlanQuery.isLoading ? (
          <Skeleton lines={4} />
        ) : prePlanQuery.isError ? (
          // Not "no pre-plan": the editor stays hidden too, or a save would replace whatever is
          // on file with an empty pre-plan.
          <div role="alert" className={styles.readError}>
            <p>Couldn&rsquo;t load the pre-plan, so it can&rsquo;t be edited right now.</p>
            <Button type="button" variant="secondary" onClick={() => void prePlanQuery.refetch()}>
              Retry
            </Button>
          </div>
        ) : prePlanQuery.data ? (
          <dl className={styles.facts}>
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
                      <a href={a.url}>{fileNameOf(a.key)}</a>
                    </li>
                  ))}
                </ul>
              ) : (
                '—'
              )}
            </dd>
            <dt>Utility shutoffs</dt>
            <dd>
              {prePlanQuery.data.utilityShutoffs.length > 0 ? (
                <ul>
                  {prePlanQuery.data.utilityShutoffs.map((s, index) => (
                    <li key={`${s.utility}-${index}`}>{`${s.utility}: ${s.location}`}</li>
                  ))}
                </ul>
              ) : (
                '—'
              )}
            </dd>
            <dt>Hazards</dt>
            <dd>
              {prePlanQuery.data.hazards.length > 0 ? prePlanQuery.data.hazards.join(', ') : '—'}
            </dd>
          </dl>
        ) : (
          <p className={styles.message}>No pre-plan is on file.</p>
        )}
      </Card>

      {prePlanSide ? (
        <div className={styles.stack}>
          {showPrePlanEditor ? (
            <Card title="Update pre-plan">
              <form
                aria-label="Save pre-plan"
                onSubmit={(event: FormEvent) => {
                  event.preventDefault();
                  setUploadStatus(null);
                  const problem = prePlanFileProblem();
                  if (problem) {
                    setFileError(problem);
                    return;
                  }
                  prePlanMutation.mutate();
                }}
                className={styles.formStack}
              >
                <label className={styles.fileField}>
                  Site diagram
                  <input
                    type="file"
                    accept={PREPLAN_FILE_ACCEPT}
                    onChange={(e) => {
                      const file = e.target.files?.[0] ?? null;
                      if (file && oversizedFileNames([file]).length > 0) {
                        setFileError(
                          `${file.name} is larger than the 20MB limit for pre-plan files.`,
                        );
                        e.target.value = '';
                        setDiagramFile(null);
                        return;
                      }
                      setFileError(null);
                      setDiagramFile(file);
                    }}
                  />
                </label>
                <label className={styles.fileField}>
                  Attachments
                  <input
                    type="file"
                    multiple
                    accept={PREPLAN_FILE_ACCEPT}
                    onChange={(e) => {
                      const files = Array.from(e.target.files ?? []);
                      const oversized = oversizedFileNames(files);
                      if (oversized.length > 0) {
                        setFileError(
                          `${oversized.join(', ')} ${oversized.length === 1 ? 'is' : 'are'} larger than the 20MB limit for pre-plan files. Remove or replace before saving.`,
                        );
                        e.target.value = '';
                        setAttachmentFiles([]);
                        return;
                      }
                      setFileError(null);
                      setAttachmentFiles(files);
                    }}
                  />
                </label>
                {fileError ? (
                  <p role="alert" aria-live="assertive" className={styles.error}>
                    {fileError}
                  </p>
                ) : null}
                <fieldset className={styles.fieldset}>
                  <legend>Utility shutoffs</legend>
                  {shutoffs.map((shutoff, index) => (
                    <div key={index} className={styles.shutoffRow}>
                      <TextInput
                        label="Utility"
                        value={shutoff.utility}
                        onChange={(e) =>
                          setShutoffs((prev) =>
                            prev.map((s, i) =>
                              i === index ? { ...s, utility: e.target.value } : s,
                            ),
                          )
                        }
                      />
                      <TextInput
                        label="Location"
                        value={shutoff.location}
                        onChange={(e) =>
                          setShutoffs((prev) =>
                            prev.map((s, i) =>
                              i === index ? { ...s, location: e.target.value } : s,
                            ),
                          )
                        }
                      />
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="secondary"
                    className={styles.fieldsetAction}
                    onClick={() => setShutoffs((prev) => [...prev, { utility: '', location: '' }])}
                  >
                    Add shutoff
                  </Button>
                </fieldset>
                <Textarea
                  label="Hazards (one per line)"
                  value={prePlanHazardsText}
                  onChange={(e) => setPrePlanHazardsDraft(e.target.value)}
                />
                <div className={styles.formActions}>
                  <p role="status" aria-live="polite" className={styles.message}>
                    {uploadStatus}
                  </p>
                  <Button type="submit" loading={prePlanMutation.isPending}>
                    Save pre-plan
                  </Button>
                </div>
              </form>
            </Card>
          ) : null}

          {prePlanMutation.error ? (
            <ApiForbiddenGate error={prePlanMutation.error} embedded>
              <p role="alert">Unable to save pre-plan</p>
            </ApiForbiddenGate>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  return (
    <main id="main-content">
      <PageHeader
        title={occupancy?.address ?? '…'}
        breadcrumbs={[
          { label: 'Occupancies', to: '/inspections/occupancies' },
          { label: occupancy?.address ?? '…' },
        ]}
        description={
          occupancy
            ? `${occupancy.occupancyType} occupancy — contacts, hazards and pre-plan`
            : undefined
        }
      />
      {occupancyQuery.isLoading || !occupancy ? (
        <Card>
          <Skeleton lines={3} />
        </Card>
      ) : (
        <Tabs
          label="Occupancy sections"
          value={tab}
          onValueChange={(value) => setTab(value as Tab)}
          items={[
            { value: 'details', label: 'Details', content: detailsPanel },
            { value: 'preplan', label: 'Pre-plan', content: prePlanPanel },
          ]}
        />
      )}
    </main>
  );
}
