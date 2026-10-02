import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import type { NerisApi } from './api.js';
import {
  MISSING_MAX_CHECKS,
  driftKey,
  repairDrift,
  diffAgainstNeris,
  previousMonth,
  reconcileDepartment,
  remindNoActivity,
} from './reconciliation.js';

const DEPT = toVerifiedDeptId({ deptId: 'NICHOLS' });
const ID = (n: string) => `FD09190828|${n}|1798000000`;

interface Command {
  readonly constructor: { name: string };
  readonly input: Record<string, unknown>;
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('diffAgainstNeris', () => {
  const local = [
    {
      incidentId: 'L1',
      nerisIncidentId: ID('4471'),
      nerisStatus: 'APPROVED',
      dispatchNumber: '4471',
    },
    {
      incidentId: 'L2',
      nerisIncidentId: ID('4472'),
      nerisStatus: 'PENDING_APPROVAL',
      dispatchNumber: '4472',
    },
    {
      incidentId: 'L3',
      nerisIncidentId: ID('4473'),
      nerisStatus: 'APPROVED',
      dispatchNumber: '4473',
    },
  ];

  it('finds records deleted in NERIS, status drift, and NERIS records Boxalarm never sent', () => {
    const drift = diffAgainstNeris(
      local,
      [
        { nerisId: ID('4471'), incidentNumber: '4471', status: 'APPROVED' },
        { nerisId: ID('4472'), incidentNumber: '4472', status: 'REJECTED' },
        { nerisId: ID('9001'), incidentNumber: '9001', status: 'SUBMITTED' },
      ],
      false,
    );
    expect(drift).toEqual([
      {
        kind: 'STATUS_MISMATCH',
        incidentId: 'L2',
        nerisIncidentId: ID('4472'),
        localStatus: 'PENDING_APPROVAL',
        nerisStatus: 'REJECTED',
      },
      {
        kind: 'MISSING_IN_NERIS',
        incidentId: 'L3',
        nerisIncidentId: ID('4473'),
        localStatus: 'APPROVED',
      },
      { kind: 'UNKNOWN_IN_NERIS', nerisIncidentId: ID('9001'), nerisStatus: 'SUBMITTED' },
    ]);
  });

  it('flags a second NERIS record that reuses a local incident number (a duplicate)', () => {
    const drift = diffAgainstNeris(
      [
        {
          incidentId: 'L1',
          nerisIncidentId: ID('4471'),
          nerisStatus: 'APPROVED',
          dispatchNumber: '4471',
        },
      ],
      [
        { nerisId: ID('4471'), incidentNumber: '4471', status: 'APPROVED' },
        { nerisId: 'FD09190828|4471|1798009999', incidentNumber: '4471', status: 'SUBMITTED' },
      ],
      false,
    );
    expect(drift).toEqual([
      {
        kind: 'UNKNOWN_IN_NERIS',
        nerisIncidentId: 'FD09190828|4471|1798009999',
        nerisStatus: 'SUBMITTED',
      },
    ]);
  });

  it('does not guess about missing records when the NERIS listing was truncated', () => {
    expect(diffAgainstNeris(local, [{ nerisId: ID('4471'), status: 'APPROVED' }], true)).toEqual(
      [],
    );
  });
});

describe('reconcileDepartment', () => {
  it('publishes neris.reconciliation.drift_detected once, with counts, and records the run', async () => {
    const sent: Command[] = [];
    const send = vi.fn((command: Command) => {
      sent.push(command);
      return Promise.resolve(
        command.constructor.name === 'QueryCommand'
          ? { Items: [{ incidentId: 'L3', nerisIncidentId: ID('4473'), dispatchNumber: '4473' }] }
          : {},
      );
    });
    const listIncidents = vi
      .fn()
      .mockResolvedValue({ ok: true, httpStatus: 200, incidents: [], truncated: false });
    const result = await reconcileDepartment(
      { send } as unknown as DynamoDBDocumentClient,
      'table',
      { listIncidents } as unknown as NerisApi,
      DEPT,
      'FD09190828',
      new Date('2026-09-29T03:00:00Z'),
      'corr',
    );
    expect(result?.drift).toHaveLength(1);
    expect(listIncidents).toHaveBeenCalledWith('FD09190828');
    const transact = sent.find((c) => c.constructor.name === 'TransactWriteCommand')!;
    const items = (
      transact.input.TransactItems as { Put: { Item: Record<string, unknown> } }[]
    ).map((i) => i.Put.Item);
    expect(items[0]).toMatchObject({ sk: 'RECONCILIATION#LAST', driftCount: 1 });
    expect(items[1]).toMatchObject({
      eventType: 'neris.reconciliation.drift_detected',
      payload: { counts: { MISSING_IN_NERIS: 1, STATUS_MISMATCH: 0, UNKNOWN_IN_NERIS: 0 } },
    });
  });

  it('writes only the run record when nothing drifted', async () => {
    const send = vi.fn().mockResolvedValue({ Items: [] });
    await reconcileDepartment(
      { send } as unknown as DynamoDBDocumentClient,
      'table',
      {
        listIncidents: () =>
          Promise.resolve({ ok: true, httpStatus: 200, incidents: [], truncated: false }),
      } as unknown as NerisApi,
      DEPT,
      'FD09190828',
      new Date('2026-09-29T03:00:00Z'),
      'corr',
    );
    expect((send.mock.calls.at(-1)![0] as Command).constructor.name).toBe('PutCommand');
  });
});

describe('no-activity reminder', () => {
  it('computes the previous calendar month', () => {
    // New York calendar months (EDT, UTC-4), not UTC ones (review minor 6).
    expect(previousMonth(new Date('2026-10-01T04:00:00Z'))).toEqual({
      month: '2026-09',
      from: Date.UTC(2026, 8, 1, 4) / 1000,
      to: Date.UTC(2026, 9, 1, 4) / 1000 - 1,
    });
    // 23:30 on 30 September in New York is still September there: the previous month is August.
    expect(previousMonth(new Date('2026-10-01T03:30:00Z')).month).toBe('2026-08');
    expect(previousMonth(new Date('2026-01-15T00:00:00Z')).month).toBe('2025-12');
  });

  function client(incidents: number, filed: boolean, reject?: Error) {
    const send = vi.fn((command: Command) => {
      if (command.constructor.name === 'QueryCommand') {
        return Promise.resolve({ Items: Array.from({ length: incidents }, () => ({})) });
      }
      if (command.constructor.name === 'GetCommand') {
        return Promise.resolve(filed ? { Item: { month: '2026-09' } } : {});
      }
      return reject ? Promise.reject(reject) : Promise.resolve({});
    });
    return { client: { send } as unknown as DynamoDBDocumentClient, send };
  }

  const now = new Date('2026-10-02T03:00:00Z');

  it('reminds once when the month closed with no incidents and nothing filed', async () => {
    const { client: ddb, send } = client(0, false);
    expect(await remindNoActivity(ddb, 'table', DEPT, now, 'corr')).toBe('reminded');
    const transact = send.mock.calls
      .map(([c]) => c)
      .find((c) => c.constructor.name === 'TransactWriteCommand')!;
    const items = (
      transact.input.TransactItems as { Put: { Item: Record<string, unknown> } }[]
    ).map((i) => i.Put.Item);
    expect(items[0]).toMatchObject({ sk: 'NO_ACTIVITY_REMINDER#2026-09' });
    expect(items[1]).toMatchObject({
      eventType: 'neris.no_activity.due',
      payload: { month: '2026-09' },
    });
  });

  it('stays quiet when the month had calls, the report is filed, or it already reminded', async () => {
    expect(await remindNoActivity(client(2, false).client, 'table', DEPT, now, 'c')).toBe(
      'not_needed',
    );
    expect(await remindNoActivity(client(0, true).client, 'table', DEPT, now, 'c')).toBe(
      'not_needed',
    );
    const already = new TransactionCanceledException({
      message: 'cancelled',
      $metadata: {},
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
    });
    expect(await remindNoActivity(client(0, false, already).client, 'table', DEPT, now, 'c')).toBe(
      'not_needed',
    );
  });
});

describe('repairDrift (review M7)', () => {
  it('applies a NERIS status the poller missed and re-queues a still-open record', async () => {
    const sent: Command[] = [];
    const send = vi.fn((command: Command) => {
      sent.push(command);
      return Promise.resolve(
        command.constructor.name === 'GetCommand'
          ? {
              Item: {
                nerisStatus: 'PENDING_APPROVAL',
                createdBy: 'MBR-0034',
                dispatchNumber: '4472',
              },
            }
          : {},
      );
    });
    const repaired = await repairDrift(
      { send } as unknown as DynamoDBDocumentClient,
      'table',
      DEPT,
      [
        {
          kind: 'STATUS_MISMATCH',
          incidentId: 'L2',
          nerisIncidentId: ID('4472'),
          localStatus: 'PENDING_APPROVAL',
          nerisStatus: 'REJECTED',
        },
        { kind: 'MISSING_IN_NERIS', incidentId: 'L3', nerisIncidentId: ID('4473') },
        { kind: 'UNKNOWN_IN_NERIS', nerisIncidentId: ID('9001') },
      ],
      [{ nerisId: ID('4472'), status: 'REJECTED', lastModified: '2026-09-30T09:00:00Z' }],
      new Date('2026-10-01T07:15:00Z'),
    );
    expect(repaired).toBe(2);
    const transact = sent.find((c) => c.constructor.name === 'TransactWriteCommand')!;
    const items = transact.input.TransactItems as Record<string, Record<string, unknown>>[];
    expect(items[0]!.Update).toMatchObject({
      ExpressionAttributeValues: { ':status': 'REJECTED' },
    });
    expect(
      items.some(
        (i) =>
          (i.Put?.Item as { eventType?: string } | undefined)?.eventType ===
          'neris.incident.rejected',
      ),
    ).toBe(true);
    const requeued = sent.find((c) => c.constructor.name === 'PutCommand')!;
    expect(requeued.input.Item).toMatchObject({ pk: 'DEPT#NICHOLS#NERIS_OPEN', sk: 'L3' });
  });

  it('gives up on a record NERIS keeps not listing: terminal, off the work list, reported once', async () => {
    const sent: Command[] = [];
    const send = vi.fn((command: Command) => {
      sent.push(command);
      return Promise.resolve(
        command.constructor.name === 'UpdateCommand'
          ? {
              Attributes: {
                nerisMissingChecks: MISSING_MAX_CHECKS,
                nerisMissingSince: 1_790_000_000,
                createdBy: 'MBR-0034',
                lockedBy: 'MBR-0002',
                dispatchNumber: '4473',
              },
            }
          : {},
      );
    });
    const repaired = await repairDrift(
      { send } as unknown as DynamoDBDocumentClient,
      'table',
      DEPT,
      [{ kind: 'MISSING_IN_NERIS', incidentId: 'L3', nerisIncidentId: ID('4473') }],
      [],
      new Date('2026-10-01T07:15:00Z'),
    );
    expect(repaired).toBe(1);
    expect(sent.some((c) => c.constructor.name === 'PutCommand')).toBe(false);
    const transact = sent.find((c) => c.constructor.name === 'TransactWriteCommand')!;
    const items = transact.input.TransactItems as Record<string, Record<string, unknown>>[];
    expect(items[0]!.Update).toMatchObject({
      Key: { sk: 'METADATA' },
      UpdateExpression: 'SET nerisMissingAt = :now',
    });
    expect(items[1]!.Delete).toMatchObject({ Key: { pk: 'DEPT#NICHOLS#NERIS_OPEN', sk: 'L3' } });
    expect(items[2]!.Put!.Item).toMatchObject({
      eventType: 'neris.incident.missing',
      payload: { incidentId: 'L3', ownerId: 'MBR-0034', lockedBy: 'MBR-0002', checks: 3 },
    });
  });

  it('skips a record already given up on or resubmitted under another id', async () => {
    const { ConditionalCheckFailedException } = await import('@aws-sdk/client-dynamodb');
    const send = vi.fn((command: Command) =>
      command.constructor.name === 'UpdateCommand'
        ? Promise.reject(new ConditionalCheckFailedException({ message: 'no', $metadata: {} }))
        : Promise.resolve({}),
    );
    const repaired = await repairDrift(
      { send } as unknown as DynamoDBDocumentClient,
      'table',
      DEPT,
      [{ kind: 'MISSING_IN_NERIS', incidentId: 'L3', nerisIncidentId: ID('4473') }],
      [],
      new Date('2026-10-01T07:15:00Z'),
    );
    expect(repaired).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('reconcileDepartment: missing records (round 2, N6)', () => {
  it('does not re-count a record already given up on, and resets the count of one seen again', async () => {
    const sent: Command[] = [];
    const send = vi.fn((command: Command) => {
      sent.push(command);
      return Promise.resolve(
        command.constructor.name === 'QueryCommand'
          ? {
              Items: [
                { incidentId: 'L3', nerisIncidentId: ID('4473'), nerisMissingAt: 1_790_000_000 },
                { incidentId: 'L4', nerisIncidentId: ID('4474'), nerisMissingChecks: 2 },
                { incidentId: 'L5', nerisIncidentId: ID('4475'), nerisMissingAt: 1_790_000_000 },
              ],
            }
          : {},
      );
    });
    const result = await reconcileDepartment(
      { send } as unknown as DynamoDBDocumentClient,
      'table',
      {
        listIncidents: () =>
          Promise.resolve({
            ok: true,
            httpStatus: 200,
            incidents: [{ nerisId: ID('4474') }, { nerisId: ID('4475') }],
            truncated: false,
          }),
      } as unknown as NerisApi,
      DEPT,
      'FD09190828',
      new Date('2026-09-29T03:00:00Z'),
      'corr',
    );
    // L5 was given up on but NERIS lists it again: its marker is cleared, not unknown drift.
    expect(result?.drift).toEqual([]);
    const resets = sent.filter((c) => c.constructor.name === 'UpdateCommand');
    expect(resets.map((c) => (c.input.Key as { pk: string }).pk)).toEqual([
      'DEPT#NICHOLS#INCIDENT#L4',
      'DEPT#NICHOLS#INCIDENT#L5',
    ]);
    expect(resets[1]!.input.UpdateExpression).toBe(
      'REMOVE nerisMissingChecks, nerisMissingSince, nerisMissingAt',
    );
  });
});

describe('reconcileDepartment: only new drift is published (round 2b, R4)', () => {
  function run(previousKeys: string[] | undefined) {
    const sent: Command[] = [];
    const send = vi.fn((command: Command) => {
      sent.push(command);
      return Promise.resolve(
        command.constructor.name === 'QueryCommand'
          ? { Items: [] }
          : command.constructor.name === 'GetCommand'
            ? previousKeys
              ? { Item: { driftKeys: previousKeys } }
              : {}
            : {},
      );
    });
    const result = reconcileDepartment(
      { send } as unknown as DynamoDBDocumentClient,
      'table',
      {
        listIncidents: () =>
          Promise.resolve({
            ok: true,
            httpStatus: 200,
            incidents: [{ nerisId: ID('9001') }],
            truncated: false,
          }),
      } as unknown as NerisApi,
      DEPT,
      'FD09190828',
      new Date('2026-09-29T03:00:00Z'),
      'corr',
    );
    return { sent, result };
  }

  it('publishes drift the first night it is seen', async () => {
    const { sent, result } = run(undefined);
    expect((await result)?.newDriftCount).toBe(1);
    expect(sent.some((c) => c.constructor.name === 'TransactWriteCommand')).toBe(true);
  });

  it('does not publish (or page) again for drift already reported, but keeps the run record', async () => {
    const { sent, result } = run([`UNKNOWN_IN_NERIS#${ID('9001')}`]);
    const outcome = await result;
    expect(outcome?.drift).toHaveLength(1);
    expect(outcome?.newDriftCount).toBe(0);
    expect(sent.some((c) => c.constructor.name === 'TransactWriteCommand')).toBe(false);
    const put = sent.find((c) => c.constructor.name === 'PutCommand')!;
    expect(put.input.Item).toMatchObject({
      sk: 'RECONCILIATION#LAST',
      driftCount: 1,
      newDriftCount: 0,
      driftKeys: [`UNKNOWN_IN_NERIS#${ID('9001')}`],
    });
  });
});

describe('driftKey (round 2c, Q2)', () => {
  it('keys a status mismatch on both statuses, so a changed mismatch is new drift', () => {
    const base = { kind: 'STATUS_MISMATCH' as const, nerisIncidentId: ID('4472') };
    const before = driftKey({ ...base, localStatus: 'PENDING_APPROVAL', nerisStatus: 'REJECTED' });
    const after = driftKey({ ...base, localStatus: 'PENDING_APPROVAL', nerisStatus: 'APPROVED' });
    expect(before).not.toBe(after);
    expect(driftKey({ kind: 'MISSING_IN_NERIS', nerisIncidentId: ID('4473') })).toBe(
      `MISSING_IN_NERIS#${ID('4473')}`,
    );
  });
});
