import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { apiRequest, ApiError, type AuthTokenSource } from '../../lib/apiClient';
import { getNerisSchema } from './api';
import { groupIncidentTypes } from './nerisIncidentTypes';

const tokens: AuthTokenSource = {
  getAccessToken: vi.fn(async () => 'unused'),
  renewSilently: vi.fn(async () => 'unused'),
};

beforeEach(() => {
  vi.stubEnv('VITE_DEMO', 'true');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

test('groups NERIS types by their first segment with readable category names', () => {
  const groups = groupIncidentTypes([
    { value: 'FIRE||STRUCTURE_FIRE||CHIMNEY_FIRE', label: 'Fire › Structure fire › Chimney fire' },
    { value: 'HAZSIT||INVESTIGATION||ODOR', label: 'Hazsit › Investigation › Odor' },
    { value: 'FIRE||OUTSIDE_FIRE||OTHER_OUTSIDE_FIRE', label: 'Fire › Outside fire › Other' },
    { value: 'LAWENFORCE', label: 'Lawenforce' },
  ]);
  expect(groups.map((group) => [group.key, group.label])).toEqual([
    ['FIRE', 'Fire'],
    ['HAZSIT', 'Hazardous situation'],
    ['LAWENFORCE', 'Law enforcement'],
  ]);
  expect(groups[0]?.options.map((option) => option.label)).toEqual([
    'Structure fire › Chimney fire',
    'Outside fire › Other',
  ]);
  expect(groups[2]?.options).toEqual([{ value: 'LAWENFORCE', label: 'Law enforcement' }]);
});

test('demo mode serves the NERIS schema and validates incident_type against it', async () => {
  const schema = await getNerisSchema(tokens);
  expect(schema.incidentTypes).toContainEqual({
    value: 'FIRE||STRUCTURE_FIRE||CHIMNEY_FIRE',
    label: 'Fire › Structure fire › Chimney fire',
  });
  expect(Object.keys(schema.modules).sort()).toEqual([
    'cooking_fire_suppression',
    'fire_alarm',
    'fire_suppression',
    'other_alarm',
    'smoke_alarm',
  ]);

  const rejected = apiRequest('incidents/i-2', tokens, {
    method: 'PUT',
    body: JSON.stringify({ fields: { incident_type: 'STRUCTURE_FIRE' } }),
  });
  await expect(rejected).rejects.toBeInstanceOf(ApiError);

  const saved = await apiRequest('incidents/i-2', tokens, {
    method: 'PUT',
    body: JSON.stringify({ fields: { incident_type: 'FIRE||STRUCTURE_FIRE||CHIMNEY_FIRE' } }),
  });
  const body = (await saved.json()) as { corePayload: Record<string, unknown> };
  expect(body.corePayload.incident_type).toBe('FIRE||STRUCTURE_FIRE||CHIMNEY_FIRE');
});

test("asks for the report's pinned schema version when given one", async () => {
  vi.stubEnv('VITE_DEMO', 'false');
  const fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify({ incidentTypes: [], modules: {} })));
  try {
    await getNerisSchema(tokens, '2026.2+neris-1.5.1');
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      '/api/v1/incidents/neris-schema?version=2026.2%2Bneris-1.5.1',
    );
  } finally {
    fetchSpy.mockRestore();
  }
});
