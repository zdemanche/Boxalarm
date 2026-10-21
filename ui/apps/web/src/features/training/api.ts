import { ApiError, apiRequest, type AuthTokenSource } from '../../lib/apiClient';
import { problemMessage } from '../personnel/problemMessage';
import type {
  AttendeeHoursInput,
  Certification,
  CreateCertificationInput,
  CreateTrainingEventInput,
  ExpiringCertification,
  RosterTrainingHours,
  Transcript,
  TranscriptExportFormat,
  TrainingEvent,
} from './types';

export function errorDetail(error: Error): string {
  if (error instanceof ApiError && Array.isArray(error.problem.errors)) {
    const reasons = error.problem.errors.flatMap((item: unknown) => {
      const { field, detail } = (item ?? {}) as { field?: unknown; detail?: unknown };
      return typeof field === 'string' && typeof detail === 'string' ? [`${field}: ${detail}`] : [];
    });
    if (reasons.length > 0) return reasons.join('; ');
  }
  return problemMessage(error);
}

const ATTACHMENT_FILENAME_MAX = 128;
const ATTACHMENT_EXTENSIONS = new Set([
  'pdf',
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'heic',
  'heif',
  'tif',
  'tiff',
  'docx',
  'xlsx',
]);

export function safeAttachmentFilename(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(-ATTACHMENT_FILENAME_MAX)
    .replace(/^[^A-Za-z0-9]+/, '');
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const cleanedDot = cleaned.lastIndexOf('.');
  const cleanedExtension = cleanedDot > 0 ? cleaned.slice(cleanedDot + 1).toLowerCase() : '';
  if (cleanedDot > 0 && ATTACHMENT_EXTENSIONS.has(cleanedExtension)) return cleaned;
  return ATTACHMENT_EXTENSIONS.has(extension) ? `attachment.${extension}` : cleaned;
}

export async function listCertifications(
  tokens: AuthTokenSource,
  memberId: string,
): Promise<Certification[]> {
  const response = await apiRequest(
    `training/members/${encodeURIComponent(memberId)}/certifications`,
    tokens,
  );
  return (await response.json()) as Certification[];
}

export async function createCertification(
  tokens: AuthTokenSource,
  memberId: string,
  input: CreateCertificationInput,
): Promise<Certification> {
  const { attachmentFilename, ...rest } = input;
  const response = await apiRequest(
    `training/members/${encodeURIComponent(memberId)}/certifications`,
    tokens,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        attachmentFilename
          ? { ...rest, attachment: { filename: safeAttachmentFilename(attachmentFilename) } }
          : rest,
      ),
    },
  );
  return (await response.json()) as Certification;
}

// The PUT is signed over Content-Type: send exactly the type the API signed it with
// (uploadContentType), or S3 refuses it. Falls back to the file's own type for an older API.
export async function uploadCertificationAttachment(
  uploadUrl: string,
  file: File,
  contentType?: string,
): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    body: file,
    headers: { 'Content-Type': contentType ?? file.type },
  });
  if (!response.ok) {
    throw new Error(`Attachment upload failed with status ${response.status}`);
  }
}

export async function revokeCertification(
  tokens: AuthTokenSource,
  memberId: string,
  certId: string,
): Promise<Certification> {
  const response = await apiRequest(
    `training/members/${encodeURIComponent(memberId)}/certifications/${encodeURIComponent(certId)}/revoke`,
    tokens,
    { method: 'POST' },
  );
  return (await response.json()) as Certification;
}

export async function listExpiringCertifications(
  tokens: AuthTokenSource,
): Promise<ExpiringCertification[]> {
  const response = await apiRequest('training/certifications/expiring', tokens);
  return (await response.json()) as ExpiringCertification[];
}

/** Department-wide hours by member and category for events starting in [from, to] (epoch ms). */
export async function getRosterTrainingHours(
  tokens: AuthTokenSource,
  from: number,
  to: number,
): Promise<RosterTrainingHours> {
  const response = await apiRequest(`training/hours?from=${from}&to=${to}`, tokens);
  return (await response.json()) as RosterTrainingHours;
}

export async function listTrainingEvents(tokens: AuthTokenSource): Promise<TrainingEvent[]> {
  const response = await apiRequest('training/events', tokens);
  return (await response.json()) as TrainingEvent[];
}

export async function createTrainingEvent(
  tokens: AuthTokenSource,
  input: CreateTrainingEventInput,
): Promise<TrainingEvent> {
  const response = await apiRequest('training/events', tokens, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const created = (await response.json()) as Omit<TrainingEvent, 'signedUp'>;
  return { ...created, signedUp: false };
}

export async function signUpForEvent(tokens: AuthTokenSource, eventId: string): Promise<void> {
  await apiRequest(`training/events/${encodeURIComponent(eventId)}/signup`, tokens, {
    method: 'POST',
  });
}

export async function recordEventHours(
  tokens: AuthTokenSource,
  eventId: string,
  attendees: readonly AttendeeHoursInput[],
): Promise<void> {
  await apiRequest(`training/events/${encodeURIComponent(eventId)}/signup`, tokens, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ attendees }),
  });
}

export async function getTranscript(
  tokens: AuthTokenSource,
  memberId: string,
): Promise<Transcript> {
  const response = await apiRequest(
    `training/members/${encodeURIComponent(memberId)}/transcript`,
    tokens,
  );
  return (await response.json()) as Transcript;
}

export async function downloadTranscript(
  tokens: AuthTokenSource,
  memberId: string,
  format: TranscriptExportFormat,
): Promise<Blob> {
  const response = await apiRequest(
    `training/members/${encodeURIComponent(memberId)}/transcript?format=${format}`,
    tokens,
  );
  return response.blob();
}
