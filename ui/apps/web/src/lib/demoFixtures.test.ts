import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { apiRequest, ApiError, type AuthTokenSource } from './apiClient';

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

test('lists apparatus fixtures without any network call', async () => {
  const response = await apiRequest('apparatus', tokens);
  const body = (await response.json()) as { items: unknown[] };
  expect(body.items.length).toBeGreaterThan(0);
});

test('creates an apparatus unit and returns it back in the list', async () => {
  const created = await apiRequest('apparatus', tokens, {
    method: 'POST',
    body: JSON.stringify({ unitId: 'Brush 1', type: 'Brush' }),
  });
  const unit = (await created.json()) as { unitId: string };
  expect(unit.unitId).toBe('Brush 1');

  const list = await apiRequest('apparatus', tokens);
  const body = (await list.json()) as { items: { unitId: string }[] };
  expect(body.items.some((a) => a.unitId === 'Brush 1')).toBe(true);
});

test('gets a member fixture by id', async () => {
  const response = await apiRequest('personnel/members/m-1', tokens);
  const member = (await response.json()) as { memberId: string; lastName: string };
  expect(member.memberId).toBe('m-1');
  expect(member.lastName).toBe('Rivera');
});

test('an unknown member id surfaces a 404 ApiError with a traceId', async () => {
  await expect(apiRequest('personnel/members/missing', tokens)).rejects.toBeInstanceOf(ApiError);
});

test('updates a member status through the fixture store', async () => {
  const response = await apiRequest('personnel/members/m-4/status', tokens, {
    method: 'PUT',
    body: JSON.stringify({ status: 'ACTIVE' }),
  });
  const member = (await response.json()) as { status: string };
  expect(member.status).toBe('ACTIVE');
});
