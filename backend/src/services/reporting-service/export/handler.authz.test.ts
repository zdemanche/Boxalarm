import { beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.hoisted(() => vi.fn());

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
  putExportJob: vi.fn(),
  getExportJob: vi.fn(),
  markExportJob: vi.fn(),
}));
vi.mock('./clients.js', () => ({
  createExportLambdaClient: () => ({ send: vi.fn() }),
  createExportS3Client: () => ({}),
  readExportsBucket: () => 'boxalarm-dev-exports-staging',
  readExportWorkerFunctionName: () => 'worker',
}));

process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';

import { Decision } from '@aws-sdk/client-verifiedpermissions';
import { handler } from './handler.js';

function buildEvent() {
  return {
    headers: { authorization: 'Bearer token' },
    queryStringParameters: { report: 'dashboard', format: 'csv' },
    requestContext: {
      authorizer: { lambda: { sub: 'member-0001', deptId: 'NICHOLS', 'cognito:groups': 'MEMBER' } },
    },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('export authorization', () => {
  it('returns 403 when Verified Permissions denies a non-admin/non-chief request', async () => {
    send.mockResolvedValue({ decision: Decision.DENY });
    const result = (await handler(buildEvent())) as { statusCode: number };
    expect(result.statusCode).toBe(403);
  });
});
