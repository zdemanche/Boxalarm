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
  recordResponse: vi.fn(),
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
        lambda: { sub: 'MBR-0012', deptId: 'NICHOLS', 'cognito:groups': 'MEMBER' },
      },
    },
    body: JSON.stringify({ ackStatus: 'RESPONDING', eta: 6 }),
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('responses handler through the real withAuthorization (AC3)', () => {
  it('returns 403 when Cedar denies the action (Cedar deny; in-service eligibility is covered in repository.test.ts, AC3)', async () => {
    send.mockResolvedValue({ decision: Decision.DENY });
    const result = (await handler(buildEvent())) as { statusCode: number };
    expect(result.statusCode).toBe(403);
  });

  it('returns 403 when the request carries no bearer token', async () => {
    const result = (await handler(buildEvent({ headers: {} }))) as { statusCode: number };
    expect(result.statusCode).toBe(403);
  });

  it('returns 503 (fail-closed) when Verified Permissions is unavailable', async () => {
    send.mockRejectedValue(new Error('VP outage'));
    const result = (await handler(buildEvent())) as { statusCode: number };
    expect(result.statusCode).toBe(503);
  });
});
