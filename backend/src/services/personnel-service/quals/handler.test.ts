import { beforeEach, describe, expect, it, vi } from 'vitest';

interface CapturedOptions {
  readonly actionType: string;
  readonly actionId: string;
  readonly resourceType: string;
  readonly resourceId: (event: { pathParameters?: { memberId?: string } }) => string;
}

const capturedOptions: CapturedOptions[] = vi.hoisted(() => []);

vi.mock('@boxalarm/authz', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@boxalarm/authz')>();
  return {
    ...actual,
    withAuthorization: (
      inner: (event: unknown, principal: unknown) => Promise<unknown>,
      options: CapturedOptions,
    ) => {
      capturedOptions.push(options);
      return async (event: { requestContext: { authorizer: { lambda: unknown } } }) =>
        inner(event, event.requestContext.authorizer.lambda);
    },
  };
});

vi.mock('../awsClients.js', () => ({
  readPersonnelServiceConfig: vi.fn(() => ({
    tableName: 'personnel-table',
    busName: 'platform-bus',
  })),
  createDynamoDocClient: vi.fn(() => ({})),
}));

const CertNotFoundError = vi.hoisted(() => class CertNotFoundError extends Error {});

vi.mock('./repository.js', () => ({
  memberExists: vi.fn(),
  putQual: vi.fn(),
  readQuals: vi.fn(),
  CertNotFoundError,
}));

import { memberExists, putQual, readQuals } from './repository.js';
import { getQualsHandler, putQualsHandler } from './handler.js';

const principal = { sub: 'member-0012', deptId: 'NICHOLS', 'cognito:groups': 'ADMIN' };

function buildEvent(overrides: Record<string, unknown> = {}) {
  return {
    headers: {},
    pathParameters: { memberId: 'MBR-0012' },
    requestContext: { authorizer: { lambda: principal } },
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getQualsHandler', () => {
  it('wires the GetQuals action against the Member resource (AC3 self-read)', () => {
    expect(capturedOptions.find((options) => options.actionId === 'GetQuals')).toMatchObject({
      actionType: 'PersonnelService',
      actionId: 'GetQuals',
      resourceType: 'Member',
    });
  });

  it('resolves the Cedar resourceId to the memberId path parameter (P5)', () => {
    const options = capturedOptions.find((option) => option.actionId === 'GetQuals');
    expect(options?.resourceId(buildEvent())).toBe('MBR-0012');
    expect(options?.resourceId({})).toBe('');
  });

  it('returns 200 with an empty array when the member holds zero quals', async () => {
    vi.mocked(readQuals).mockResolvedValue([]);
    const result = (await getQualsHandler(buildEvent())) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual([]);
  });

  it('returns all held quals and their currentlyEligible flag (AC3)', async () => {
    vi.mocked(readQuals).mockResolvedValue([
      { qualCode: 'INTERIOR', grantedByCertId: null, currentlyEligible: true },
    ]);
    const result = (await getQualsHandler(buildEvent())) as { body: string };
    expect(JSON.parse(result.body)).toEqual([
      { qualCode: 'INTERIOR', grantedByCertId: null, currentlyEligible: true },
    ]);
  });

  it('returns 404 when memberId is missing from the path (P5)', async () => {
    const result = (await getQualsHandler(buildEvent({ pathParameters: {} }))) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(404);
    expect(readQuals).not.toHaveBeenCalled();
  });

  it('propagates a readQuals rejection rather than swallowing it (P5)', async () => {
    vi.mocked(readQuals).mockRejectedValue(new Error('table unavailable'));
    await expect(getQualsHandler(buildEvent())).rejects.toThrow('table unavailable');
  });
});

describe('putQualsHandler', () => {
  it('wires the UpdateQuals action against the Member resource (AC1 admin-write)', () => {
    expect(capturedOptions.find((options) => options.actionId === 'UpdateQuals')).toMatchObject({
      actionType: 'PersonnelService',
      actionId: 'UpdateQuals',
      resourceType: 'Member',
    });
  });

  it('resolves the Cedar resourceId to the memberId path parameter (P5)', () => {
    const options = capturedOptions.find((option) => option.actionId === 'UpdateQuals');
    expect(options?.resourceId(buildEvent())).toBe('MBR-0012');
    expect(options?.resourceId({})).toBe('');
  });

  it('returns 404 when grantedByCertId names a certification that does not exist (P6)', async () => {
    vi.mocked(memberExists).mockResolvedValue(true);
    vi.mocked(putQual).mockRejectedValue(new CertNotFoundError('CERT-MISSING'));
    const result = (await putQualsHandler(
      buildEvent({
        body: JSON.stringify({ qualCode: 'INTERIOR', grantedByCertId: 'CERT-MISSING' }),
      }),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(404);
  });

  it('writes a qual with currentlyEligible=true and grantedByCertId null when not cert-backed (AC1)', async () => {
    vi.mocked(memberExists).mockResolvedValue(true);
    vi.mocked(putQual).mockResolvedValue({
      qualCode: 'INTERIOR',
      grantedByCertId: null,
      currentlyEligible: true,
    });
    const result = (await putQualsHandler(
      buildEvent({ body: JSON.stringify({ qualCode: 'INTERIOR' }) }),
    )) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(200);
    expect(putQual).toHaveBeenCalledWith(
      expect.anything(),
      'personnel-table',
      'NICHOLS',
      'MBR-0012',
      'INTERIOR',
      null,
      expect.any(String),
    );
    expect(JSON.parse(result.body)).toEqual({
      qualCode: 'INTERIOR',
      grantedByCertId: null,
      currentlyEligible: true,
    });
  });

  it('returns 422 on an absent request body', async () => {
    const result = (await putQualsHandler(buildEvent({ body: undefined }))) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(422);
    expect(putQual).not.toHaveBeenCalled();
  });

  it('returns 422 when qualCode is empty', async () => {
    const result = (await putQualsHandler(
      buildEvent({ body: JSON.stringify({ qualCode: '' }) }),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(422);
  });

  it('returns 422 when qualCode is wrong-typed', async () => {
    const result = (await putQualsHandler(
      buildEvent({ body: JSON.stringify({ qualCode: 42 }) }),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(422);
  });

  it('returns 404 when the member does not exist', async () => {
    vi.mocked(memberExists).mockResolvedValue(false);
    const result = (await putQualsHandler(
      buildEvent({ body: JSON.stringify({ qualCode: 'INTERIOR' }) }),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(404);
    expect(putQual).not.toHaveBeenCalled();
  });

  it('emits a business metric on write success', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(memberExists).mockResolvedValue(true);
    vi.mocked(putQual).mockResolvedValue({
      qualCode: 'INTERIOR',
      grantedByCertId: null,
      currentlyEligible: true,
    });
    await putQualsHandler(buildEvent({ body: JSON.stringify({ qualCode: 'INTERIOR' }) }));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('PersonnelQualsWriteSucceeded'));
  });

  it('emits a business metric on write failure and rethrows without swallowing', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(memberExists).mockResolvedValue(true);
    vi.mocked(putQual).mockRejectedValue(new Error('transact failed'));
    await expect(
      putQualsHandler(buildEvent({ body: JSON.stringify({ qualCode: 'INTERIOR' }) })),
    ).rejects.toThrow('transact failed');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('PersonnelQualsWriteFailed'));
  });
});
