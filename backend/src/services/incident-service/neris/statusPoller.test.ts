import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import type { NerisApi, NerisHistoryEntry } from './api.js';
import { pollRecord, runStatusPoll, scannerDeptIds } from './statusPoller.js';

const DEPT = toVerifiedDeptId({ deptId: 'NICHOLS' });
const OPEN = {
  incidentId: 'NICHOLS-4471-1798000000',
  nerisIncidentId: 'FD09190828|4471|1798000000',
};

interface Command {
  readonly constructor: { name: string };
  readonly input: Record<string, unknown>;
}

function ddb(metadata: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) {
  const sent: Command[] = [];
  const send = vi.fn((command: Command) => {
    sent.push(command);
    switch (command.constructor.name) {
      case 'GetCommand':
        return Promise.resolve({ Item: metadata });
      case 'QueryCommand':
        return Promise.resolve(extra.query ?? { Items: [] });
      default:
        return Promise.resolve({});
    }
  });
  return { client: { send } as unknown as DynamoDBDocumentClient, sent };
}

function api(history: NerisHistoryEntry[] | 'fail'): NerisApi {
  return {
    getIncidentHistory: vi
      .fn()
      .mockResolvedValue(
        history === 'fail'
          ? { ok: false, kind: 'server_error', httpStatus: 503, issues: [] }
          : { ok: true, httpStatus: 200, history },
      ),
  } as unknown as NerisApi;
}

const METADATA = {
  pk: 'x',
  nerisStatus: 'PENDING_APPROVAL',
  dispatchNumber: '4471',
  createdBy: 'MBR-0034',
};

function transactItems(sent: Command[]): Record<string, Record<string, unknown>>[] {
  const transact = sent.find((c) => c.constructor.name === 'TransactWriteCommand');
  return (transact?.input.TransactItems ?? []) as Record<string, Record<string, unknown>>[];
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('pollRecord', () => {
  it('does nothing while NERIS still reports the stored status', async () => {
    const { client, sent } = ddb(METADATA);
    const outcome = await pollRecord(
      client,
      'table',
      api([{ status: 'PENDING_APPROVAL', current: true, lastModified: '2026-09-29T10:05:00Z' }]),
      DEPT,
      'FD09190828',
      OPEN,
      1_798_100_000,
    );
    expect(outcome).toBe('unchanged');
    expect(sent.map((c) => c.constructor.name)).toEqual(['GetCommand']);
  });

  it('on REJECTED: stores status and history, notifies the owner via the outbox, stops watching', async () => {
    const { client, sent } = ddb(METADATA);
    const outcome = await pollRecord(
      client,
      'table',
      api([
        { status: 'SUBMITTED', current: false, lastModified: '2026-09-29T10:00:00Z' },
        { status: 'PENDING_APPROVAL', current: false, lastModified: '2026-09-29T10:05:00Z' },
        { status: 'REJECTED', current: true, lastModified: '2026-09-30T09:00:00Z' },
      ]),
      DEPT,
      'FD09190828',
      OPEN,
      1_798_100_000,
    );

    expect(outcome).toBe('changed');
    const items = transactItems(sent);
    expect(items[0]!.Update).toMatchObject({
      ExpressionAttributeValues: { ':status': 'REJECTED', ':local': 'REJECTED' },
    });
    const puts = items.filter((i) => i.Put).map((i) => i.Put!.Item as Record<string, unknown>);
    expect(puts.filter((p) => p.entityType === 'NERIS_STATUS_HISTORY')).toHaveLength(3);
    expect(puts.find((p) => p.eventType === 'neris.incident.rejected')).toMatchObject({
      payload: {
        incidentId: OPEN.incidentId,
        ownerId: 'MBR-0034',
        nerisStatus: 'REJECTED',
        previousNerisStatus: 'PENDING_APPROVAL',
        incidentNumber: '4471',
      },
    });
    expect(items.some((i) => i.Delete)).toBe(true);
  });

  it('on APPROVED marks the report accepted and emits neris.incident.approved', async () => {
    const { client, sent } = ddb(METADATA);
    await pollRecord(
      client,
      'table',
      api([{ status: 'APPROVED', current: true, lastModified: '2026-09-30T09:00:00Z' }]),
      DEPT,
      'FD09190828',
      OPEN,
      1_798_100_000,
    );
    const items = transactItems(sent);
    expect(items[0]!.Update).toMatchObject({ ExpressionAttributeValues: { ':local': 'ACCEPTED' } });
    expect(
      items.some(
        (i) => (i.Put?.Item as { eventType?: string })?.eventType === 'neris.incident.approved',
      ),
    ).toBe(true);
  });

  it('keeps watching a record that moved to another open status, with no event', async () => {
    const { client, sent } = ddb({ ...METADATA, nerisStatus: 'SUBMITTED' });
    await pollRecord(
      client,
      'table',
      api([{ status: 'PENDING_APPROVAL', current: true, lastModified: '2026-09-29T10:05:00Z' }]),
      DEPT,
      'FD09190828',
      OPEN,
      1_798_100_000,
    );
    const items = transactItems(sent);
    expect(items.some((i) => i.Delete)).toBe(false);
    expect(
      items.some((i) => (i.Put?.Item as { entityType?: string })?.entityType === 'OUTBOX_ENTRY'),
    ).toBe(false);
  });

  it('reports a NERIS failure without writing', async () => {
    const { client, sent } = ddb(METADATA);
    expect(await pollRecord(client, 'table', api('fail'), DEPT, 'FD09190828', OPEN, 1)).toBe(
      'failed',
    );
    expect(sent).toHaveLength(0);
  });
});

describe('runStatusPoll', () => {
  it('reads the work list per scanner department and keeps going past a failing record', async () => {
    process.env.INCIDENT_TABLE_NAME = 'table';
    process.env.NERIS_SCANNER_DEPT_ID = 'NICHOLS';
    const send = vi.fn((command: Command) => {
      const pk = (command.input.ExpressionAttributeValues as Record<string, string> | undefined)?.[
        ':pk'
      ];
      if (command.constructor.name === 'QueryCommand' && pk === 'DEPT#NICHOLS#NERIS') {
        return Promise.resolve({ Items: [{ sk: 'SETTINGS', departmentNerisId: 'FD09190828' }] });
      }
      if (command.constructor.name === 'QueryCommand') {
        return Promise.resolve({
          Items: [
            { incidentId: 'A', nerisIncidentId: 'FD09190828|A|1798000000' },
            { incidentId: 'B', nerisIncidentId: 'FD09190828|B|1798000000' },
          ],
        });
      }
      return Promise.resolve({ Item: METADATA });
    });
    const getIncidentHistory = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce({
        ok: true,
        httpStatus: 200,
        history: [{ status: 'APPROVED', current: true, lastModified: '2026-09-30T09:00:00Z' }],
      });
    await runStatusPoll('corr-1', {
      client: { send } as unknown as DynamoDBDocumentClient,
      api: { getIncidentHistory } as unknown as NerisApi,
    });
    expect(getIncidentHistory).toHaveBeenCalledTimes(2);
    expect(getIncidentHistory).toHaveBeenLastCalledWith('FD09190828', 'FD09190828|B|1798000000');
    expect(send.mock.calls.some(([c]) => c.constructor.name === 'TransactWriteCommand')).toBe(true);
  });

  it('parses a comma-separated department list', () => {
    expect(scannerDeptIds({ NERIS_SCANNER_DEPT_ID: 'NICHOLS, STRATFORD' })).toEqual([
      'NICHOLS',
      'STRATFORD',
    ]);
    expect(() => scannerDeptIds({})).toThrow(/NERIS_SCANNER_DEPT_ID/);
  });
});
