import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Decision } from '@aws-sdk/client-verifiedpermissions';
import { DEFAULT_NERIS_SETTINGS } from './nerisSettings.js';
import { OFFICER_AUTH, buildIncidentEvent } from './testEvents.js';

const vpSend = vi.fn();
vi.mock('@aws-sdk/client-verifiedpermissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-verifiedpermissions')>();
  return {
    ...actual,
    VerifiedPermissionsClient: vi.fn().mockImplementation(() => ({ send: vpSend })),
  };
});

interface Command {
  readonly constructor: { name: string };
  readonly input: Record<string, unknown>;
}

const ddbSend = vi.fn();
const createNoActivityReport = vi.fn();
const listNoActivityReports = vi.fn();
let spies: { mockRestore: () => void }[] = [];

function setup(options: { filed?: boolean; count?: number; departmentNerisId?: string | null }) {
  ddbSend.mockImplementation((command: Command) => {
    if (command.constructor.name === 'GetCommand') {
      return Promise.resolve(options.filed ? { Item: { nerisUid: 'nar-0' } } : {});
    }
    if (command.constructor.name === 'QueryCommand') {
      return Promise.resolve({ Count: options.count ?? 0 });
    }
    return Promise.resolve({});
  });
  vi.doMock('./repository.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./repository.js')>();
    return { ...actual, getDocumentClient: () => ({ send: ddbSend }) };
  });
  vi.doMock('./nerisSettings.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./nerisSettings.js')>();
    return {
      ...actual,
      getNerisDeptSettings: () =>
        Promise.resolve({
          ...DEFAULT_NERIS_SETTINGS,
          ...(options.departmentNerisId === null
            ? {}
            : { departmentNerisId: options.departmentNerisId ?? 'FD09190828' }),
        }),
    };
  });
  vi.doMock('./reportContext.js', () => ({
    nerisApiFromEnv: () => Promise.resolve({ createNoActivityReport, listNoActivityReports }),
  }));
}

async function post(body: unknown): Promise<{ statusCode: number; json: Record<string, unknown> }> {
  const { handler } = (await import('./noActivityReport.js')) as {
    handler: (event: unknown) => Promise<{ statusCode: number; body: string }>;
  };
  const result = await handler(
    buildIncidentEvent({
      method: 'POST',
      routeKey: 'POST /api/v1/incidents/no-activity-reports',
      auth: OFFICER_AUTH,
      body,
    }),
  );
  return {
    statusCode: result.statusCode,
    json: JSON.parse(result.body) as Record<string, unknown>,
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
  process.env.INCIDENT_TABLE_NAME = 'incident-table';
  vpSend.mockResolvedValue({ decision: Decision.ALLOW });
  listNoActivityReports.mockResolvedValue({ ok: true, httpStatus: 200, reports: [] });
  spies = [
    vi.spyOn(console, 'log').mockImplementation(() => undefined),
    vi.spyOn(console, 'error').mockImplementation(() => undefined),
  ];
});

afterEach(() => {
  vi.doUnmock('./repository.js');
  vi.doUnmock('./nerisSettings.js');
  vi.doUnmock('./reportContext.js');
  spies.forEach((spy) => spy.mockRestore());
});

describe('POST /incidents/no-activity-reports', () => {
  it('files MM/YYYY with NERIS for a closed month with no incidents, and records it', async () => {
    setup({});
    createNoActivityReport.mockResolvedValue({ ok: true, httpStatus: 201, nerisUid: 'nar-1' });
    const { statusCode, json } = await post({ month: '2026-08' });

    expect(statusCode).toBe(201);
    expect(json).toMatchObject({ month: '2026-08', nerisUid: 'nar-1', filedBy: 'MBR-0034' });
    expect(createNoActivityReport).toHaveBeenCalledWith('FD09190828', '08/2026');
    const transact = ddbSend.mock.calls
      .map(([c]) => c as Command)
      .find((c) => c.constructor.name === 'TransactWriteCommand')!;
    const items = (
      transact.input.TransactItems as { Put: { Item: Record<string, unknown> } }[]
    ).map((i) => i.Put.Item);
    expect(items[0]).toMatchObject({ sk: 'NO_ACTIVITY#2026-08', nerisUid: 'nar-1' });
    expect(items[1]).toMatchObject({ eventType: 'neris.no_activity.submitted' });
    expect(
      (vpSend.mock.calls[0]![0] as { input: { action: { actionId: string } } }).input.action
        .actionId,
    ).toBe('FileNoActivityReport');
  });

  it('refuses a bad or open month, a month with calls, a second filing, and an unregistered department', async () => {
    setup({});
    expect((await post({ month: '08/2026' })).statusCode).toBe(400);
    expect((await post({ month: '2999-01' })).statusCode).toBe(400);

    vi.resetModules();
    setup({ count: 3 });
    expect((await post({ month: '2026-08' })).json.code).toBe('MONTH_HAS_INCIDENTS');

    vi.resetModules();
    setup({ filed: true });
    expect((await post({ month: '2026-08' })).json.code).toBe('ALREADY_FILED');

    vi.resetModules();
    setup({ departmentNerisId: null });
    expect((await post({ month: '2026-08' })).json.code).toBe('NOT_CONFIGURED');
    expect(createNoActivityReport).not.toHaveBeenCalled();
  });

  it('adopts a report NERIS already holds for the month instead of filing a second one', async () => {
    setup({});
    listNoActivityReports.mockResolvedValue({
      ok: true,
      httpStatus: 200,
      reports: [{ nerisUid: 'nar-earlier' }],
    });
    const { statusCode, json } = await post({ month: '2026-08' });
    expect(statusCode).toBe(201);
    expect(json.nerisUid).toBe('nar-earlier');
    expect(listNoActivityReports).toHaveBeenCalledWith('FD09190828', '08/2026');
    expect(createNoActivityReport).not.toHaveBeenCalled();
  });

  it('counts incidents in the department time zone (review minor 6)', async () => {
    setup({});
    createNoActivityReport.mockResolvedValue({ ok: true, httpStatus: 201, nerisUid: 'n' });
    await post({ month: '2026-08' });
    const query = ddbSend.mock.calls
      .map(([c]) => c as Command)
      .find((c) => c.constructor.name === 'QueryCommand')!;
    expect(query.input.ExpressionAttributeValues).toMatchObject({
      ':from': `INCIDENT#${Date.UTC(2026, 7, 1, 4) / 1000}`,
      ':to': `INCIDENT#${Date.UTC(2026, 8, 1, 4) / 1000 - 1}`,
    });
  });

  it('passes NERIS 422 issues back as a blocking list', async () => {
    setup({});
    createNoActivityReport.mockResolvedValue({
      ok: false,
      kind: 'validation',
      httpStatus: 422,
      issues: [{ path: 'month_year', code: 'string_pattern_mismatch', message: 'bad' }],
    });
    const { statusCode, json } = await post({ month: '2026-08' });
    expect(statusCode).toBe(422);
    expect(json.blocking).toEqual([
      expect.objectContaining({ code: 'NERIS_STRING_PATTERN_MISMATCH', path: 'month_year' }),
    ]);
  });
});
