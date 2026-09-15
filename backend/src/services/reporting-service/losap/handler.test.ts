import { beforeEach, describe, expect, it, vi } from 'vitest';

interface CapturedOptions {
  readonly actionType: string;
  readonly actionId: string;
  readonly resourceType: string;
  readonly resourceId: (event: {
    requestContext: { authorizer?: { lambda?: { deptId?: string } } };
  }) => string;
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
  readReportingServiceConfig: vi.fn(() => ({ tableName: 'platform-table' })),
  createDynamoDocClient: vi.fn(() => ({})),
}));

vi.mock('./repository.js', () => ({
  buildYearEndReport: vi.fn(),
}));

import { buildYearEndReport } from './repository.js';
import { handler } from './handler.js';

const principal = { sub: 'member-0001', deptId: 'NICHOLS', 'cognito:groups': 'ADMIN' };

function buildEvent(overrides: Record<string, unknown> = {}) {
  return {
    headers: {},
    queryStringParameters: { year: '2026' },
    requestContext: { authorizer: { lambda: principal } },
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('losap year-end handler', () => {
  it('wires the GetLosapYearEnd action against the Department resource (AC5 attachment point)', () => {
    expect(capturedOptions[0]).toMatchObject({
      actionType: 'ReportingService',
      actionId: 'GetLosapYearEnd',
      resourceType: 'Department',
    });
  });

  it('resolves the Cedar resourceId to the principal deptId', () => {
    expect(capturedOptions[0]?.resourceId(buildEvent())).toBe('NICHOLS');
  });

  it('returns 200 with the aggregated report on success (AC1)', async () => {
    vi.mocked(buildYearEndReport).mockResolvedValue({
      deptId: 'NICHOLS',
      year: 2026,
      members: [{ memberId: 'MBR-0001', totalPoints: 3, entryCount: 2 }],
      hasData: true,
    });
    const result = (await handler(buildEvent())) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      deptId: 'NICHOLS',
      year: 2026,
      members: [{ memberId: 'MBR-0001', totalPoints: 3, entryCount: 2 }],
      hasData: true,
    });
  });

  it('returns 200 with hasData=false and no error for a year with no data yet (AC4)', async () => {
    vi.mocked(buildYearEndReport).mockResolvedValue({
      deptId: 'NICHOLS',
      year: 2026,
      members: [{ memberId: 'MBR-0001', totalPoints: 0, entryCount: 0 }],
      hasData: false,
    });
    const result = (await handler(buildEvent())) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(200);
    expect((JSON.parse(result.body) as { hasData: boolean }).hasData).toBe(false);
  });

  it('returns 400 when year is missing', async () => {
    const result = (await handler(buildEvent({ queryStringParameters: {} }))) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(400);
    expect(buildYearEndReport).not.toHaveBeenCalled();
  });

  it('returns 400 when year is non-numeric', async () => {
    const result = (await handler(buildEvent({ queryStringParameters: { year: 'abc' } }))) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(400);
  });

  it('returns 400 when year is not a 4-digit integer', async () => {
    const result = (await handler(buildEvent({ queryStringParameters: { year: '2026.5' } }))) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(400);
  });

  it('returns 400 for a duplicated query param collapsed into one comma-joined string', async () => {
    const result = (await handler(
      buildEvent({ queryStringParameters: { year: '2026,2027' } }),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(400);
  });

  it('emits a business metric on success', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(buildYearEndReport).mockResolvedValue({
      deptId: 'NICHOLS',
      year: 2026,
      members: [],
      hasData: false,
    });
    await handler(buildEvent());
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('ReportingLosapYearEndSucceeded'));
  });

  it('returns 503, logs the original error, and emits a failure metric when aggregation fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(buildYearEndReport).mockRejectedValue(new Error('table unavailable'));
    const result = (await handler(buildEvent())) as { statusCode: number };
    expect(result.statusCode).toBe(503);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('table unavailable'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('ReportingLosapYearEndFailed'));
  });
});
