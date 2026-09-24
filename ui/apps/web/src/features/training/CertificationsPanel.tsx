import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import {
  createCertification,
  listCertifications,
  revokeCertification,
  uploadCertificationAttachment,
} from './api';
import type { Certification, CreateCertificationInput } from './types';

const emptyForm: CreateCertificationInput = {
  certType: '',
  issueDate: '',
  expiryDate: '',
  issuingAuthority: '',
};

interface PendingUpload {
  certId: string;
  uploadUrl: string;
  file: File;
}

export function CertificationsPanel({ memberId }: { memberId: string }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const isTraining = auth.roles.includes('TRAINING') || auth.roles.includes('ADMIN');
  const queryKey = ['training', 'certifications', memberId];

  const [form, setForm] = useState<CreateCertificationInput>(emptyForm);
  const [file, setFile] = useState<File | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingUpload, setPendingUpload] = useState<PendingUpload | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const certsQuery = useQuery({
    queryKey,
    queryFn: () => listCertifications(auth, memberId),
  });

  const attemptUpload = async (upload: PendingUpload) => {
    try {
      await uploadCertificationAttachment(upload.uploadUrl, upload.file);
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
        await attemptUpload({ certId: created.certId, uploadUrl: created.uploadUrl, file });
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

  return (
    <section aria-label="Certifications" style={{ marginTop: 'var(--boxalarm-spacing-lg)' }}>
      <h2 style={{ fontSize: 'var(--boxalarm-font-size-lg)', margin: 0 }}>Certifications</h2>

      {certsQuery.isLoading ? (
        <p>Loading certifications…</p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 'var(--boxalarm-spacing-md) 0', padding: 0 }}>
          {(certsQuery.data ?? []).map((cert) => (
            <li
              key={cert.certId}
              style={{
                padding: 'var(--boxalarm-spacing-sm) 0',
                borderBottom: '1px solid var(--boxalarm-fg)',
              }}
            >
              <strong>{cert.certType}</strong> — {cert.status} · expires {cert.expiryDate} ·{' '}
              {cert.issuingAuthority}
              {cert.attachmentS3Key ? (
                <>
                  {' '}
                  · <span>attachment: {cert.attachmentS3Key.split('/').pop()}</span>
                </>
              ) : null}
              {isTraining && cert.status !== 'REVOKED' ? (
                <>
                  {' '}
                  <button
                    type="button"
                    onClick={() => revokeMutation.mutate(cert.certId)}
                    disabled={revokeMutation.isPending}
                    style={{ minHeight: 44 }}
                  >
                    Revoke
                  </button>
                </>
              ) : null}
            </li>
          ))}
          {(certsQuery.data ?? []).length === 0 ? <li>No certifications on file.</li> : null}
        </ul>
      )}

      {pendingUpload ? (
        <div role="alert" style={{ marginTop: 'var(--boxalarm-spacing-sm)' }}>
          <p>{uploadError}</p>
          <button
            type="button"
            onClick={() => void attemptUpload(pendingUpload)}
            style={{ minHeight: 44 }}
          >
            Retry upload
          </button>
        </div>
      ) : null}

      {isTraining ? (
        <form
          onSubmit={onSubmit}
          aria-label="Add certification"
          style={{
            marginTop: 'var(--boxalarm-spacing-lg)',
            display: 'grid',
            gap: 'var(--boxalarm-spacing-md)',
            maxWidth: 480,
          }}
        >
          <h3 style={{ fontSize: 'var(--boxalarm-font-size-base)', margin: 0 }}>
            Add certification
          </h3>
          <label style={{ display: 'grid', gap: 4 }}>
            Certification type
            <input
              value={form.certType}
              onChange={(e) => setForm((prev) => ({ ...prev, certType: e.target.value }))}
              required
              style={{ minHeight: 44, padding: '0 12px' }}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            Issue date
            <input
              type="date"
              value={form.issueDate}
              onChange={(e) => setForm((prev) => ({ ...prev, issueDate: e.target.value }))}
              required
              style={{ minHeight: 44, padding: '0 12px' }}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            Expiry date
            <input
              type="date"
              value={form.expiryDate}
              onChange={(e) => setForm((prev) => ({ ...prev, expiryDate: e.target.value }))}
              required
              style={{ minHeight: 44, padding: '0 12px' }}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            Issuing authority
            <input
              value={form.issuingAuthority}
              onChange={(e) => setForm((prev) => ({ ...prev, issuingAuthority: e.target.value }))}
              required
              style={{ minHeight: 44, padding: '0 12px' }}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            Attachment (optional)
            <input
              type="file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              style={{ minHeight: 44 }}
            />
          </label>
          {formError ? (
            <p role="alert" aria-live="assertive">
              {formError}
            </p>
          ) : null}
          <button type="submit" disabled={createMutation.isPending} style={{ minHeight: 44 }}>
            Add certification
          </button>
        </form>
      ) : null}
    </section>
  );
}
