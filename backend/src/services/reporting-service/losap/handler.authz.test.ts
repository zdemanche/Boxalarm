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
  readReportingServiceConfig: vi.fn(() => ({ tableName: 'platform-table' })),
  createDynamoDocClient: vi.fn(() => ({})),
}));

vi.mock('./repository.js', () => ({
  buildYearEndReport: vi.fn(),
}));

process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';

import { Decision } from '@aws-sdk/client-verifiedpermissions';
import { handler } from './handler.js';

function buildEvent(overrides: Record<string, unknown> = {}) {
  return {
    headers: { authorization: 'Bearer token' },
    queryStringParameters: { year: '2026' },
    requestContext: {
      authorizer: {
        lambda: { sub: 'member-0001', deptId: 'NICHOLS', 'cognito:groups': 'MEMBER' },
      },
    },
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('losap year-end handler through the real withAuthorization', () => {
  it('returns 403 when Verified Permissions denies a non-admin request (AC5)', async () => {
    send.mockResolvedValue({ decision: Decision.DENY });
    const result = (await handler(buildEvent())) as { statusCode: number };
    expect(result.statusCode).toBe(403);
  });

  it('returns 503, fail-closed, when Verified Permissions is unavailable (never a defaulted allow)', async () => {
    send.mockRejectedValue(new Error('VP outage'));
    const result = (await handler(buildEvent())) as { statusCode: number };
    expect(result.statusCode).toBe(503);
  });
});
