import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { canManageTraining } from '../../auth/roles';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import type { StatusRole } from '@boxalarm/design-tokens';
import { Button, Card, ConfirmDialog, Skeleton, StatusChip, TextInput } from '../../components/ui';
import {
  createCertification,
  listCertifications,
  revokeCertification,
  uploadCertificationAttachment,
} from './api';
import type { Certification, CertificationStatus, CreateCertificationInput } from './types';
import { formatCalendarDate } from '../../lib/dates';
import { humanize } from '../../lib/labels';
import styles from './training.module.css';

const CERT_STATUS_ROLE: Record<CertificationStatus, StatusRole> = {
  CURRENT: 'ok',
  EXPIRED: 'danger',
  REVOKED: 'neutral',
};

const emptyForm: CreateCertificationInput = {
  certType: '',
  issueDate: '',
  expiryDate: '',
  issuingAuthority: '',
};

interface PendingUpload {
  certId: string;
  uploadUrl: string;
  contentType?: string;
  file: File;
}

export function CertificationsPanel({
  memberId,
  title = 'Certifications',
}: {
  memberId: string;
  /** The card's heading; the Certifications page names the member it shows. */
  title?: string;
}) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const isTraining = canManageTraining(auth.roles);
  const queryKey = ['training', 'certifications', memberId];

  const [form, setForm] = useState<CreateCertificationInput>(emptyForm);
  const [file, setFile] = useState<File | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingUpload, setPendingUpload] = useState<PendingUpload | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<Certification | null>(null);

  const certsQuery = useQuery({
    queryKey,
    queryFn: () => listCertifications(auth, memberId),
  });

  const attemptUpload = async (upload: PendingUpload) => {
    try {
      await uploadCertificationAttachment(upload.uploadUrl, upload.file, upload.contentType);
      setPendingUpload(null);
      setUploadError(null);
    } catch {
      setPendingUpload(upload);
      setUploadError('Attachment upload failed. You can retry without creating a duplicate.');
    }
  };

  const createMutation = useMutation({
    mutationFn: (input: CreateCertificationInput) => createCertification(auth, memberId, input),
    onSuccess: async (created: Certification) => {
      setForm(emptyForm);
      setFormError(null);
      await queryClient.invalidateQueries({ queryKey });
      if (created.uploadUrl && file) {
        await attemptUpload({
          certId: created.certId,
          uploadUrl: created.uploadUrl,
          ...(created.uploadContentType ? { contentType: created.uploadContentType } : {}),
          file,
        });
      }
      setFile(null);
    },
    onError: (error: Error) => {
      setFormError(error.message);
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (certId: string) => revokeCertification(auth, memberId, certId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    createMutation.mutate({ ...form, attachmentFilename: file?.name });
  };

  if (certsQuery.error) {
    return (
      <ApiForbiddenGate error={certsQuery.error} embedded>
        <p>Unexpected error</p>
      </ApiForbiddenGate>
    );
  }

  const certs = certsQuery.data ?? [];

  return (
    <Card title={title}>
      {certsQuery.isLoading ? (
        <Skeleton lines={3} />
      ) : certs.length === 0 ? (
        <p className={styles.muted}>No certifications on file.</p>
      ) : (
        <ul className={styles.list}>
          {certs.map((cert) => (
            <li key={cert.certId} className={styles.row}>
              <span className={styles.rowMain}>
                <span className={styles.rowTitle}>{cert.certType}</span>
                <span className={styles.rowMeta}>
                  {cert.issuingAuthority} · expires {formatCalendarDate(cert.expiryDate)}
                  {cert.attachmentS3Key
                    ? ` · attachment: ${cert.attachmentS3Key.split('/').pop()}`
                    : null}
                </span>
              </span>
              <span className={styles.rowAside}>
                <StatusChip status={CERT_STATUS_ROLE[cert.status]}>
                  {humanize(cert.status)}
                </StatusChip>
                {isTraining && cert.status !== 'REVOKED' ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setRevokeTarget(cert)}
                  >
                    Revoke
                  </Button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}

      {pendingUpload ? (
        <div role="alert" className={styles.uploadAlert}>
          <p className={styles.error}>{uploadError}</p>
          <Button
            type="button"
            variant="secondary"
            onClick={() => void attemptUpload(pendingUpload)}
          >
            Retry upload
          </Button>
        </div>
      ) : null}

      {isTraining ? (
        <form onSubmit={onSubmit} aria-label="Add certification" className={styles.subsection}>
          <h3 className={styles.subhead}>Add certification</h3>
          <div className={styles.formGrid}>
            <TextInput
              label="Certification type"
              value={form.certType}
              onChange={(e) => setForm((prev) => ({ ...prev, certType: e.target.value }))}
              required
            />
            <TextInput
              label="Issuing authority"
              value={form.issuingAuthority}
              onChange={(e) => setForm((prev) => ({ ...prev, issuingAuthority: e.target.value }))}
              required
            />
            <TextInput
              label="Issue date"
              type="date"
              value={form.issueDate}
              onChange={(e) => setForm((prev) => ({ ...prev, issueDate: e.target.value }))}
              required
            />
            <TextInput
              label="Expiry date"
              type="date"
              value={form.expiryDate}
              onChange={(e) => setForm((prev) => ({ ...prev, expiryDate: e.target.value }))}
              required
            />
            <label className={styles.fileField}>
              Attachment (optional)
              <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </label>
          </div>
          <div className={styles.formActions}>
            {formError ? (
              <p role="alert" aria-live="assertive" className={styles.error}>
                {formError}
              </p>
            ) : null}
            <Button type="submit" variant="secondary" loading={createMutation.isPending}>
              Add certification
            </Button>
          </div>
        </form>
      ) : null}

      {/* Revoke is irreversible: confirm, naming the certification (PR #321 review m2/m3).
          The dialog shows a failed revoke inline instead of closing blind. */}
      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        title={`Revoke ${revokeTarget?.certType ?? 'certification'}?`}
        consequence={`${revokeTarget?.certType ?? 'This certification'} (${revokeTarget?.issuingAuthority ?? ''}) will be marked revoked for this member. This cannot be undone.`}
        confirmLabel="Revoke certification"
        danger
        onConfirm={async () => {
          if (revokeTarget) await revokeMutation.mutateAsync(revokeTarget.certId);
        }}
      />
    </Card>
  );
}
