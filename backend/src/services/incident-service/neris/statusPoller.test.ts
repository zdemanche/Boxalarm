import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import type { NerisApi, NerisHistoryEntry } from './api.js';
import {
  MAX_RECORDS_PER_RUN,
  pollInterval,
  pollRecord,
  runStatusPoll,
  scannerDeptIds,
} from './statusPoller.js';

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

describe('stale reads and history keys (review minors 2, 11)', () => {
  it('writes only over the NERIS record and status it read, and drops a superseded read', async () => {
    const { TransactionCanceledException } = await import('@aws-sdk/client-dynamodb');
    const send = vi.fn((command: Command) => {
      if (command.constructor.name === 'GetCommand') return Promise.resolve({ Item: METADATA });
      return Promise.reject(
        new TransactionCanceledException({
          message: 'cancelled',
          $metadata: {},
          CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
        }),
      );
    });
    const outcome = await pollRecord(
      { send } as unknown as DynamoDBDocumentClient,
      'table',
      api([
        { status: 'REJECTED', current: true, lastModified: '' },
        { status: 'SUBMITTED', current: false, lastModified: '' },
      ]),
      DEPT,
      'FD09190828',
      OPEN,
      1_798_100_000,
    );
    expect(outcome).toBe('unchanged');
    const transact = send.mock.calls
      .map(([c]) => c)
      .find((c) => c.constructor.name === 'TransactWriteCommand')!;
    const items = transact.input.TransactItems as Record<string, Record<string, unknown>>[];
    expect(items[0]!.Update).toMatchObject({
      ConditionExpression:
        'attribute_exists(pk) AND nerisIncidentId = :nerisId AND nerisStatus = :previous',
      ExpressionAttributeValues: {
        ':nerisId': OPEN.nerisIncidentId,
        ':previous': 'PENDING_APPROVAL',
      },
    });
    const keys = items
      .filter(
        (i) => (i.Put?.Item as { entityType?: string })?.entityType === 'NERIS_STATUS_HISTORY',
      )
      .map((i) => (i.Put!.Item as { sk: string }).sk);
    expect(new Set(keys).size).toBe(2);
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

describe('work-list rotation, backoff and age-out (review M7)', () => {
  const NOW = 1_800_000_000;

  function world(rows: Record<string, unknown>[], cursor?: string) {
    const sent: Command[] = [];
    const send = vi.fn((command: Command) => {
      sent.push(command);
      const input = command.input;
      const pk = (input.ExpressionAttributeValues as Record<string, string> | undefined)?.[':pk'];
      if (command.constructor.name === 'QueryCommand' && pk === 'DEPT#NICHOLS#NERIS') {
        return Promise.resolve({ Items: [{ sk: 'SETTINGS', departmentNerisId: 'FD09190828' }] });
      }
      if (command.constructor.name === 'QueryCommand') {
        const start = (input.ExclusiveStartKey as { sk?: string } | undefined)?.sk;
        const from = start ? rows.findIndex((r) => r.incidentId === start) + 1 : 0;
        const limit = input.Limit as number;
        const page = rows.slice(from, from + limit);
        const more = from + limit < rows.length;
        return Promise.resolve({
          Items: page,
          ...(more ? { LastEvaluatedKey: { pk: 'x', sk: page[page.length - 1]!.incidentId } } : {}),
        });
      }
      if (command.constructor.name === 'GetCommand') {
        const sk = (input.Key as { sk: string }).sk;
        return Promise.resolve(
          sk === 'POLLER#CURSOR'
            ? cursor
              ? { Item: { lastIncidentId: cursor } }
              : {}
            : { Item: METADATA },
        );
      }
      return Promise.resolve({});
    });
    return { client: { send } as unknown as DynamoDBDocumentClient, sent };
  }

  const unchangedApi = () => {
    const history = vi.fn().mockResolvedValue({
      ok: true,
      httpStatus: 200,
      history: [{ status: 'PENDING_APPROVAL', current: true, lastModified: 't' }],
    });
    return { api: { getIncidentHistory: history } as unknown as NerisApi, history };
  };

  beforeEach(() => {
    process.env.INCIDENT_TABLE_NAME = 'table';
    process.env.NERIS_SCANNER_DEPT_ID = 'NICHOLS';
  });

  it('continues from the saved cursor, so records past the first page are reached', async () => {
    const rows = Array.from({ length: MAX_RECORDS_PER_RUN + 50 }, (_, i) => ({
      incidentId: `I-${String(i).padStart(4, '0')}`,
      nerisIncidentId: `FD09190828|${i}|1798000000`,
      since: NOW - 600,
    }));
    const { api, history } = unchangedApi();
    const first = world(rows);
    await runStatusPoll('c', { client: first.client, api, now: () => NOW });
    expect(history).toHaveBeenCalledTimes(MAX_RECORDS_PER_RUN);
    const saved = first.sent.find(
      (c) =>
        c.constructor.name === 'PutCommand' &&
        (c.input.Item as { sk: string }).sk === 'POLLER#CURSOR',
    );
    const cursor = (saved!.input.Item as { lastIncidentId: string }).lastIncidentId;
    expect(cursor).toBe(`I-${String(MAX_RECORDS_PER_RUN - 1).padStart(4, '0')}`);

    const second = unchangedApi();
    await runStatusPoll('c', {
      client: world(rows, cursor).client,
      api: second.api,
      now: () => NOW,
    });
    expect(second.history).toHaveBeenCalledTimes(50);
    expect(second.history.mock.calls[0]![1]).toBe(`FD09190828|${MAX_RECORDS_PER_RUN}|1798000000`);
  });

  it('skips records that are not due and backs off by age', async () => {
    const { api, history } = unchangedApi();
    const { client, sent } = world([
      { incidentId: 'A', nerisIncidentId: 'FD09190828|A|1', since: NOW - 2 * 86_400 },
      {
        incidentId: 'B',
        nerisIncidentId: 'FD09190828|B|1',
        since: NOW - 60,
        nextPollAt: NOW + 100,
      },
    ]);
    await runStatusPoll('c', { client, api, now: () => NOW });
    expect(history).toHaveBeenCalledTimes(1);
    const update = sent.find((c) => c.constructor.name === 'UpdateCommand')!;
    expect(update.input.ExpressionAttributeValues).toEqual({
      ':next': NOW + 3_600,
      ':failures': 0,
    });
    expect(pollInterval(60)).toBe(300);
    expect(pollInterval(30 * 86_400)).toBe(21_600);
  });

  it('ages out a record NERIS keeps failing on, with an event, instead of polling it forever', async () => {
    const api = {
      getIncidentHistory: vi
        .fn()
        .mockResolvedValue({ ok: false, kind: 'client_error', httpStatus: 404, issues: [] }),
    } as unknown as NerisApi;
    const { client, sent } = world([
      { incidentId: 'A', nerisIncidentId: 'FD09190828|A|1', since: NOW - 600, failures: 11 },
    ]);
    await runStatusPoll('c', { client, api, now: () => NOW });
    const transact = sent.find((c) => c.constructor.name === 'TransactWriteCommand')!;
    const items = transact.input.TransactItems as Record<string, Record<string, unknown>>[];
    expect(items[0]!.Delete).toBeDefined();
    expect(items[1]!.Put!.Item).toMatchObject({
      eventType: 'neris.incident.poll_expired',
      payload: { reason: 'POLL_FAILURES', failures: 12 },
    });
  });
});
