import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { AuditHistoryLink } from '../../components/AuditHistoryLink';
import {
  Button,
  Card,
  ConfirmDialog,
  PageHeader,
  Skeleton,
  Tabs,
  Textarea,
  TextInput,
} from '../../components/ui';
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

const safeFileName = (file: File) => file.name.replace(/[^A-Za-z0-9._-]/g, '_');

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
  // Storage keys of files on file that the next save leaves out. Nothing is removed until then.
  const [removedKeys, setRemovedKeys] = useState<string[]>([]);
  const [confirmRemovalOpen, setConfirmRemovalOpen] = useState(false);

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

  const filesOnFile: { key: string; kind: 'diagram' | 'attachment' }[] = [
    ...(prePlanQuery.data?.siteDiagramS3Key
      ? [{ key: prePlanQuery.data.siteDiagramS3Key, kind: 'diagram' as const }]
      : []),
    ...(prePlanQuery.data?.attachmentS3Keys ?? []).map((key) => ({
      key,
      kind: 'attachment' as const,
    })),
  ];
  const markedNames = filesOnFile
    .filter((file) => removedKeys.includes(file.key))
    .map((file) => fileNameOf(file.key));

  // The PUT replaces the whole pre-plan, so files already on file are named again (same
  // pre-plan id, same key) or the save would drop them; leaving one out is how it is removed.
  // A new attachment with an on-file name replaces that file.
  function plannedFiles() {
    const onFile = prePlanQuery.data;
    const newNames = attachmentFiles.map(safeFileName);
    const keptAttachments = (onFile?.attachmentS3Keys ?? [])
      .filter((key) => !removedKeys.includes(key))
      .map(fileNameOf)
      .filter((name) => !newNames.includes(name));
    const keptDiagram =
      onFile?.siteDiagramS3Key && !removedKeys.includes(onFile.siteDiagramS3Key)
        ? fileNameOf(onFile.siteDiagramS3Key)
        : null;
    return {
      siteDiagramFilename: diagramFile ? safeFileName(diagramFile) : keptDiagram,
      keptAttachments,
      newNames,
    };
  }

  const hazardsMutation = useMutation({
    mutationFn: () => updateOccupancy(auth, id, { hazards: splitLines(hazardsText) }),
    onSuccess: (occupancy) => {
      queryClient.setQueryData(['inspections', 'occupancies', id], occupancy);
      setHazardsDraft(null);
    },
  });

  const prePlanMutation = useMutation({
    mutationFn: async () => {
      // Only new files are uploaded below.
      const { siteDiagramFilename, keptAttachments, newNames } = plannedFiles();
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
        const file = attachmentFiles.find((f) => safeFileName(f) === attachment.filename);
        if (file) await uploadPrePlanFile(attachment.uploadUrl, file, attachment.contentType);
      }
      return result;
    },
    onSuccess: async () => {
      setUploadStatus('Pre-plan saved.');
      setDiagramFile(null);
      setAttachmentFiles([]);
      await queryClient.invalidateQueries({ queryKey: ['inspections', 'preplan', id] });
      // After the refetch, so a removed file doesn't flash back unmarked before it disappears.
      setRemovedKeys([]);
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

  // Every stored file is `{prePlanId}/{name}`: a new file named like one that stays would
  // overwrite it, and the service accepts at most 50 attachments per save. Files marked for
  // removal don't count, so removing one frees its name and its place.
  function prePlanFileProblem(): string | null {
    const { siteDiagramFilename, keptAttachments, newNames } = plannedFiles();
    const clash = attachmentFiles.find((file) => safeFileName(file) === siteDiagramFilename);
    if (clash) {
      return `${clash.name} has the same name as the site diagram. Rename one of them before saving.`;
    }
    if (diagramFile && keptAttachments.includes(safeFileName(diagramFile))) {
      return `${diagramFile.name} has the same name as an attachment on file. Rename one of them before saving.`;
    }
    const repeated = attachmentFiles.find(
      (file, index) => newNames.indexOf(safeFileName(file)) !== index,
    );
    if (repeated) {
      return `${repeated.name} has the same name as another new attachment. Rename one of them before saving.`;
    }
    const total = keptAttachments.length + newNames.length;
    if (total > MAX_PREPLAN_ATTACHMENTS) {
      return `A pre-plan holds at most ${MAX_PREPLAN_ATTACHMENTS} attachments; this save would have ${total}.`;
    }
    return null;
  }

  const toggleRemoval = (key: string) =>
    setRemovedKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

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
                  setFileError(problem);
                  if (problem) return;
                  // A saved removal can't be undone here (only by uploading the file again),
                  // so it is confirmed by name first (docs/design.md §4.5).
                  if (markedNames.length > 0) {
                    setConfirmRemovalOpen(true);
                    return;
                  }
                  prePlanMutation.mutate();
                }}
                className={styles.formStack}
              >
                {filesOnFile.length > 0 ? (
                  <fieldset className={styles.fieldset}>
                    <legend>Current files</legend>
                    <ul className={styles.list}>
                      {filesOnFile.map(({ key, kind }) => {
                        const name = fileNameOf(key);
                        const marked = removedKeys.includes(key);
                        const what = kind === 'diagram' ? 'site diagram' : `attachment ${name}`;
                        const meta = marked
                          ? 'Removed when you save'
                          : kind === 'attachment'
                            ? 'Attachment'
                            : diagramFile
                              ? `Site diagram, replaced by ${diagramFile.name} when you save`
                              : 'Site diagram';
                        return (
                          <li key={`${kind}:${key}`} className={styles.row}>
                            <span className={styles.rowBody}>
                              <span className={styles.rowTitle}>
                                {marked ? <s>{name}</s> : name}
                              </span>
                              {/* Live, so pressing Remove or Undo is heard, not only seen. */}
                              <span className={styles.rowMeta} aria-live="polite">
                                {meta}
                              </span>
                            </span>
                            <span className={styles.rowAside}>
                              <Button
                                variant="secondary"
                                size="sm"
                                aria-label={marked ? `Undo removing ${what}` : `Remove ${what}`}
                                onClick={() => toggleRemoval(key)}
                              >
                                {marked ? 'Undo' : 'Remove'}
                              </Button>
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </fieldset>
                ) : null}
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
              <ConfirmDialog
                open={confirmRemovalOpen}
                onOpenChange={setConfirmRemovalOpen}
                title={
                  markedNames.length === 1
                    ? `Remove ${markedNames[0]} from the ${occupancy?.address ?? ''} pre-plan?`
                    : `Remove ${markedNames.length} files from the ${occupancy?.address ?? ''} pre-plan?`
                }
                consequence={
                  markedNames.length === 1
                    ? 'Crews will no longer see it on this pre-plan. To get it back, upload it again.'
                    : 'Crews will no longer see them on this pre-plan. To get one back, upload it again.'
                }
                confirmLabel={
                  markedNames.length === 1
                    ? `Remove ${markedNames[0]} and save`
                    : `Remove ${markedNames.length} files and save`
                }
                danger
                onConfirm={() => prePlanMutation.mutate()}
              >
                {markedNames.length > 1 ? (
                  <ul className={styles.list}>
                    {markedNames.map((name, index) => (
                      <li key={`${index}:${name}`} className={`${styles.row} ${styles.rowTitle}`}>
                        {name}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </ConfirmDialog>
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
        // Occupancy audit entries are keyed by this route's id (occupancy/repository.ts,
        // archive/archiveRepository.ts). Pre-plan saves write no audit entry of their own.
        actions={<AuditHistoryLink entityType="OCCUPANCY" entityId={id} />}
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
