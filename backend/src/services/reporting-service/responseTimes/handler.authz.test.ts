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
  createDynamoDocClient: vi.fn(() => ({})),
}));

vi.mock('./repository.js', () => ({ loadResponseTimeAnalytics: vi.fn() }));

process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
process.env.INCIDENT_TABLE_NAME = 'incident-table';

import { Decision } from '@aws-sdk/client-verifiedpermissions';
import { handler } from './handler.js';

function buildEvent() {
  return {
    headers: { authorization: 'Bearer token' },
    queryStringParameters: { from: '1', to: '2' },
    requestContext: {
      authorizer: { lambda: { sub: 'member-0001', deptId: 'NICHOLS', 'cognito:groups': 'MEMBER' } },
    },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('response-times authorization', () => {
  it('returns 403 when Verified Permissions denies a non-admin/non-chief request', async () => {
    send.mockResolvedValue({ decision: Decision.DENY });
    const result = (await handler(buildEvent())) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(403);
  });
});
