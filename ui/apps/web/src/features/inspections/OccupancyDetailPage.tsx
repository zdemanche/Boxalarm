import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { Button, Card, PageHeader, Skeleton, Tabs, Textarea, TextInput } from '../../components/ui';
import { getOccupancy, getPrePlan, putPrePlan, updateOccupancy, uploadPrePlanFile } from './api';
import type { UtilityShutoff } from './types';
import styles from './OccupancyDetail.module.css';

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

  const detailsPanel = occupancy ? (
    <>
      <Card>
        <dl className={styles.facts}>
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
      </Card>

      {canWrite ? (
        <Card title="Edit hazards" style={{ marginTop: 'var(--bx-space-xl)', maxWidth: 480 }}>
          <form
            aria-label="Edit hazards"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              hazardsMutation.mutate();
            }}
            style={{ display: 'grid', gap: 'var(--bx-space-md)' }}
          >
            <Textarea
              label="Hazards (one per line)"
              value={hazardsText}
              onChange={(e) => setHazardsDraft(e.target.value)}
            />
            <Button type="submit" loading={hazardsMutation.isPending}>
              Save hazards
            </Button>
          </form>
        </Card>
      ) : null}

      {hazardsMutation.error ? (
        <ApiForbiddenGate error={hazardsMutation.error} embedded>
          <p role="alert">Unable to save changes</p>
        </ApiForbiddenGate>
      ) : null}
    </>
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

  const prePlanPanel = (
    <>
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
        <Card>
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
              {prePlanQuery.data.utilityShutoffs.length > 0
                ? prePlanQuery.data.utilityShutoffs
                    .map((s) => `${s.utility}: ${s.location}`)
                    .join('; ')
                : '—'}
            </dd>
            <dt>Hazards</dt>
            <dd>
              {prePlanQuery.data.hazards.length > 0 ? prePlanQuery.data.hazards.join(', ') : '—'}
            </dd>
          </dl>
        </Card>
      ) : (
        <p>No pre-plan is on file.</p>
      )}

      {/* Success includes a 404 (no pre-plan yet), which the client maps to null. */}
      {canWrite && prePlanQuery.isSuccess ? (
        <Card title="Update pre-plan" style={{ marginTop: 'var(--bx-space-xl)', maxWidth: 480 }}>
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
            style={{ display: 'grid', gap: 'var(--bx-space-md)' }}
          >
            <label style={{ display: 'grid', gap: 4 }}>
              Site diagram
              <input
                type="file"
                accept={PREPLAN_FILE_ACCEPT}
                onChange={(e) => {
                  const file = e.target.files?.[0] ?? null;
                  if (file && oversizedFileNames([file]).length > 0) {
                    setFileError(`${file.name} is larger than the 20MB limit for pre-plan files.`);
                    e.target.value = '';
                    setDiagramFile(null);
                    return;
                  }
                  setFileError(null);
                  setDiagramFile(file);
                }}
              />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
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
              <p role="alert" aria-live="assertive">
                {fileError}
              </p>
            ) : null}
            <fieldset
              style={{ display: 'grid', gap: 'var(--bx-space-sm)', border: 'none', padding: 0 }}
            >
              <legend>Utility shutoffs</legend>
              {shutoffs.map((shutoff, index) => (
                <div key={index} style={{ display: 'flex', gap: 'var(--bx-space-sm)' }}>
                  <TextInput
                    label="Utility"
                    value={shutoff.utility}
                    onChange={(e) =>
                      setShutoffs((prev) =>
                        prev.map((s, i) => (i === index ? { ...s, utility: e.target.value } : s)),
                      )
                    }
                    style={{ flex: 1 }}
                  />
                  <TextInput
                    label="Location"
                    value={shutoff.location}
                    onChange={(e) =>
                      setShutoffs((prev) =>
                        prev.map((s, i) => (i === index ? { ...s, location: e.target.value } : s)),
                      )
                    }
                    style={{ flex: 1 }}
                  />
                </div>
              ))}
              <Button
                type="button"
                variant="secondary"
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
            <Button type="submit" loading={prePlanMutation.isPending}>
              Save pre-plan
            </Button>
            <p role="status" aria-live="polite">
              {uploadStatus}
            </p>
          </form>
        </Card>
      ) : null}

      {prePlanMutation.error ? (
        <ApiForbiddenGate error={prePlanMutation.error} embedded>
          <p role="alert">Unable to save pre-plan</p>
        </ApiForbiddenGate>
      ) : null}
    </>
  );

  return (
    <main id="main-content">
      <PageHeader
        title={occupancy?.address ?? '…'}
        breadcrumbs={[
          { label: 'Occupancies', to: '/inspections/occupancies' },
          { label: occupancy?.address ?? '…' },
        ]}
      />
      {occupancyQuery.isLoading || !occupancy ? (
        <Skeleton lines={3} />
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
