import { apiRequest, type AuthTokenSource } from '../../lib/apiClient';
import type {
  Certification,
  NotificationChannelMutes,
  NotificationItem,
  NotificationPreference,
  Transcript,
  TrainingEvent,
} from './types';

export async function getCertifications(
  tokens: AuthTokenSource,
  apiBaseUrl: string,
  memberId: string,
): Promise<Certification[]> {
  const response = await apiRequest(
    `training/members/${encodeURIComponent(memberId)}/certifications`,
    tokens,
    { apiBaseUrl },
  );
  return (await response.json()) as Certification[];
}

export async function getTranscript(
  tokens: AuthTokenSource,
  apiBaseUrl: string,
  memberId: string,
): Promise<Transcript> {
  const response = await apiRequest(
    `training/members/${encodeURIComponent(memberId)}/transcript`,
    tokens,
    { apiBaseUrl },
  );
  return (await response.json()) as Transcript;
}

export async function getTrainingEvents(
  tokens: AuthTokenSource,
  apiBaseUrl: string,
): Promise<TrainingEvent[]> {
  const response = await apiRequest('training/events', tokens, { apiBaseUrl });
  return (await response.json()) as TrainingEvent[];
}

export async function signUpForEvent(
  tokens: AuthTokenSource,
  apiBaseUrl: string,
  eventId: string,
): Promise<void> {
  await apiRequest(`training/events/${encodeURIComponent(eventId)}/signup`, tokens, {
    apiBaseUrl,
    method: 'POST',
  });
}

export async function getNotifications(
  tokens: AuthTokenSource,
  apiBaseUrl: string,
): Promise<NotificationItem[]> {
  const response = await apiRequest('notifications', tokens, { apiBaseUrl });
  const body = (await response.json()) as { items: NotificationItem[] };
  return body.items;
}

export async function markNotificationRead(
  tokens: AuthTokenSource,
  apiBaseUrl: string,
  notificationId: string,
): Promise<void> {
  await apiRequest(`notifications/${encodeURIComponent(notificationId)}/read`, tokens, {
    apiBaseUrl,
    method: 'POST',
  });
}

export async function getNotificationPreferences(
  tokens: AuthTokenSource,
  apiBaseUrl: string,
): Promise<NotificationPreference[]> {
  const response = await apiRequest('notifications/preferences', tokens, { apiBaseUrl });
  const body = (await response.json()) as { preferences: NotificationPreference[] };
  return body.preferences;
}

export async function putNotificationPreference(
  tokens: AuthTokenSource,
  apiBaseUrl: string,
  category: string,
  channels: NotificationChannelMutes,
): Promise<void> {
  await apiRequest('notifications/preferences', tokens, {
    apiBaseUrl,
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category, channels }),
  });
}
