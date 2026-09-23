import { beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn();

vi.mock('@aws-sdk/client-verifiedpermissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-verifiedpermissions')>();
  return {
    ...actual,
    VerifiedPermissionsClient: vi.fn().mockImplementation(() => ({ send })),
  };
});

vi.mock('../awsClients.js', () => ({
  readPersonnelServiceConfig: vi.fn(() => ({
    tableName: 'personnel-table',
    busName: 'platform-bus',
  })),
  createDynamoDocClient: vi.fn(() => ({})),
}));

vi.mock('./repository.js', () => ({
  memberExists: vi.fn(),
  putQual: vi.fn(),
  readQuals: vi.fn(),
}));

process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';

import { Decision } from '@aws-sdk/client-verifiedpermissions';
import { getQualsHandler, putQualsHandler } from './handler.js';

function buildEvent(overrides: Record<string, unknown> = {}) {
  return {
    headers: { authorization: 'Bearer token' },
    pathParameters: { memberId: 'MBR-0012' },
    requestContext: {
      authorizer: {
        lambda: { sub: 'member-0012', deptId: 'NICHOLS', 'cognito:groups': 'ADMIN' },
      },
    },
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('quals handlers through the real withAuthorization (P9)', () => {
  it('returns 403 when Verified Permissions denies the request', async () => {
    send.mockResolvedValue({ decision: Decision.DENY });
    const result = (await putQualsHandler(
      buildEvent({ body: JSON.stringify({ qualCode: 'INTERIOR' }) }),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(403);
  });

  it('returns 503 (fail-closed) when Verified Permissions is unavailable', async () => {
    send.mockRejectedValue(new Error('VP outage'));
    const result = (await getQualsHandler(buildEvent())) as { statusCode: number };
    expect(result.statusCode).toBe(503);
  });
});
