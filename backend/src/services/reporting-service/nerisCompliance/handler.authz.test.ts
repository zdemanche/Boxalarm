import { beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn();
const ddbSend = vi.fn();

vi.mock('@aws-sdk/client-verifiedpermissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-verifiedpermissions')>();
  return {
    ...actual,
    VerifiedPermissionsClient: vi.fn().mockImplementation(function () {
      return { send };
    }),
  };
});

vi.mock('../awsClients.js', () => ({ createDynamoDocClient: vi.fn(() => ({ send: ddbSend })) }));

process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
process.env.INCIDENT_TABLE_NAME = 'incident-table';
process.env.PLATFORM_SERVICE_TABLE_NAME = 'platform-table';

import { Decision } from '@aws-sdk/client-verifiedpermissions';
import { handler } from './handler.js';

function buildEvent(query: Record<string, string> = {}) {
  return {
    headers: { authorization: 'Bearer token' },
    queryStringParameters: query,
    requestContext: {
      authorizer: { lambda: { sub: 'chief-1', deptId: 'NICHOLS', 'cognito:groups': 'CHIEF' } },
    },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /reporting/neris-compliance', () => {
  it('authorizes ViewNerisCompliance on the department and returns the tile', async () => {
    send.mockResolvedValue({ decision: Decision.ALLOW });
    ddbSend.mockImplementation((command: { constructor: { name: string } }) =>
      Promise.resolve(
        command.constructor.name === 'GetCommand'
          ? { Item: { firstName: 'Pat', lastName: 'Ryan' } }
          : { Items: [{ incidentId: 'A', alarmAt: 1, createdBy: 'M' }] },
      ),
    );
    const result = (await handler(buildEvent({ days: '30' }))) as {
      statusCode: number;
      body: string;
    };
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      windowDays: 30,
      openDrafts: [{ id: 'A', owner: 'M', ownerName: 'Pat Ryan', locked: false }],
    });
    const vpInput = (send.mock.calls[0]![0] as { input: Record<string, unknown> }).input;
    expect(vpInput).toMatchObject({
      action: { actionId: 'ViewNerisCompliance' },
      resource: { entityType: 'Boxalarm::Department', entityId: 'NICHOLS' },
    });
    const query = (ddbSend.mock.calls[0]![0] as { input: Record<string, unknown> }).input;
    expect(query).toMatchObject({ TableName: 'incident-table', IndexName: 'GSI1' });
  });

  it('returns 403 when Cedar denies and 400 for a bad window', async () => {
    send.mockResolvedValue({ decision: Decision.DENY });
    expect(((await handler(buildEvent())) as { statusCode: number }).statusCode).toBe(403);
    send.mockResolvedValue({ decision: Decision.ALLOW });
    expect(((await handler(buildEvent({ days: '0' }))) as { statusCode: number }).statusCode).toBe(
      400,
    );
  });
});
