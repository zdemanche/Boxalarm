import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { Button, Card, PageHeader, Skeleton, Tabs, Textarea, TextInput } from '../../components/ui';
import { getOccupancy, getPrePlan, putPrePlan, updateOccupancy, uploadPrePlanFile } from './api';
import type { UtilityShutoff } from './types';

type Tab = 'details' | 'preplan';

/** Site diagrams and supporting attachments only — the file types a pre-plan needs. */
const PREPLAN_FILE_ACCEPT = '.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg';
const MAX_PREPLAN_FILE_BYTES = 20 * 1024 * 1024; // 20MB — generous for a scanned floor plan/photo

function oversizedFileNames(files: File[]): string[] {
  return files.filter((file) => file.size > MAX_PREPLAN_FILE_BYTES).map((file) => file.name);
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
  const [hazardsText, setHazardsText] = useState('');
  const [diagramFile, setDiagramFile] = useState<File | null>(null);
  const [attachmentFiles, setAttachmentFiles] = useState<File[]>([]);
  const [shutoffs, setShutoffs] = useState<UtilityShutoff[]>([]);
  const [prePlanHazardsText, setPrePlanHazardsText] = useState('');
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

  const detailsPanel = occupancy ? (
    <>
      <Card>
        <dl style={{ margin: 0 }}>
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
              onChange={(e) => setHazardsText(e.target.value)}
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

  const prePlanPanel = (
    <>
      {prePlanQuery.isLoading ? (
        <Skeleton lines={4} />
      ) : prePlanQuery.data ? (
        <Card>
          <dl style={{ margin: 0 }}>
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
              {prePlanQuery.data.hazards.length > 0 ? prePlanQuery.data.hazards.join(', ') : '—'}
            </dd>
          </dl>
        </Card>
      ) : (
        <p>No pre-plan is on file.</p>
      )}

      {canWrite ? (
        <Card title="Update pre-plan" style={{ marginTop: 'var(--bx-space-xl)', maxWidth: 480 }}>
          <form
            aria-label="Save pre-plan"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              setUploadStatus(null);
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
              onChange={(e) => setPrePlanHazardsText(e.target.value)}
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
