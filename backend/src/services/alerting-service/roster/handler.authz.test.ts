import { beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn();

vi.mock('@aws-sdk/client-verifiedpermissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-verifiedpermissions')>();
  return {
    ...actual,
    VerifiedPermissionsClient: vi.fn().mockImplementation(() => ({ send })),
  };
});

vi.mock('../eligibility/dynamoClient.js', () => ({
  readAlertingConfig: vi.fn(() => ({ tableName: 'alerting-table' })),
  createDynamoClient: vi.fn(() => ({})),
}));

vi.mock('./repository.js', () => ({
  queryRoster: vi.fn(),
}));

process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';

import { Decision } from '@aws-sdk/client-verifiedpermissions';
import { handler } from './handler.js';

function buildEvent(overrides: Record<string, unknown> = {}) {
  return {
    headers: { authorization: 'Bearer token' },
    pathParameters: { dispatchId: 'NICHOLS-4471-1798000000' },
    requestContext: {
      authorizer: {
        lambda: { sub: 'OFF-0001', deptId: 'NICHOLS', 'cognito:groups': 'OFFICER' },
      },
    },
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('roster handler through the real withAuthorization', () => {
  it('returns 403 when Verified Permissions denies the request', async () => {
    send.mockResolvedValue({ decision: Decision.DENY });
    const result = (await handler(buildEvent())) as { statusCode: number };
    expect(result.statusCode).toBe(403);
  });

  it('returns 503 (fail-closed) when Verified Permissions is unavailable', async () => {
    send.mockRejectedValue(new Error('VP outage'));
    const result = (await handler(buildEvent())) as { statusCode: number };
    expect(result.statusCode).toBe(503);
  });
});
