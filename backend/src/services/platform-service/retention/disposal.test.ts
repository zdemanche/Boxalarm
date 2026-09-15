import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeleteCommand, GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { DEFAULT_RETENTION_YEARS } from './configRepository.js';
import { SECONDS_PER_YEAR, runDisposal } from './disposal.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const OTHER_DEPT = toVerifiedDeptId({ deptId: 'TRUMBULL' });

function keyOf(pk: string, sk: string): string {
  return `${pk}\0${sk}`;
}

/** In-memory Dynamo stand-in so hard-delete is proven via GetItem, not mock call counts. */
function createMemoryDocClient(seed: Record<string, Record<string, unknown>> = {}) {
  const store = new Map<string, Record<string, unknown>>(
    Object.entries(seed).map(([key, value]) => [key, { ...value }]),
  );

  const send = vi.fn((command: unknown) => {
    if (command instanceof GetCommand) {
      const pk = command.input.Key?.pk as string;
      const sk = command.input.Key?.sk as string;
      const item = store.get(keyOf(pk, sk));
      return item ? { Item: item } : {};
    }
    if (command instanceof DeleteCommand) {
      const pk = command.input.Key?.pk as string;
      const sk = command.input.Key?.sk as string;
      store.delete(keyOf(pk, sk));
      return {};
    }
    return {};
  });

  return {
    client: { send } as unknown as DynamoDBDocumentClient,
    store,
    send,
  };
}

describe('runDisposal hard-delete (AC2)', () => {
  beforeEach(() => {
    process.env.PLATFORM_TABLE_NAME = 'platform-service';
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('hard-deletes OUT_OF_SERVICE_RECORD past configured retention so GetItem returns nothing', async () => {
    const nowEpoch = 1_800_000_000;
    const retentionYears = 5;
    const tooOldStartAt = nowEpoch - retentionYears * SECONDS_PER_YEAR - 1;
    const oosPk = buildDeptScopedPk(DEPT_ID, 'APPARATUS', 'APP-1');
    const oosSk = `OOS#${tooOldStartAt}`;

    const { client, store } = createMemoryDocClient({
      [keyOf(buildDeptScopedPk(DEPT_ID), 'CONFIG#RETENTION')]: {
        pk: buildDeptScopedPk(DEPT_ID),
        sk: 'CONFIG#RETENTION',
        entityType: 'DEPARTMENT_CONFIG',
        configType: 'RETENTION',
        value: { retentionYears },
        version: 1,
      },
      [keyOf(oosPk, oosSk)]: {
        pk: oosPk,
        sk: oosSk,
        entityType: 'OUT_OF_SERVICE_RECORD',
        reason: 'Brake repair',
        startAt: tooOldStartAt,
        endAt: tooOldStartAt + 86_400,
      },
    });

    const result = await runDisposal({
      docClient: client,
      deptId: DEPT_ID,
      actorId: 'MBR-CHIEF',
      traceId: 'trace-disposal-1',
      nowEpochSeconds: nowEpoch,
      candidates: [{ pk: oosPk, sk: oosSk }],
    });

    expect(result.hardDeleted).toBe(1);
    expect(store.has(keyOf(oosPk, oosSk))).toBe(false);

    const getAfter = await client.send(
      new GetCommand({
        TableName: 'platform-service',
        Key: { pk: oosPk, sk: oosSk },
      }),
    );
    expect(getAfter.Item).toBeUndefined();
  });

  it('leaves LOB records inside the retention window untouched', async () => {
    const nowEpoch = 1_800_000_000;
    const recentStartAt = nowEpoch - 100;
    const oosPk = buildDeptScopedPk(DEPT_ID, 'APPARATUS', 'APP-2');
    const oosSk = `OOS#${recentStartAt}`;

    const { client, store } = createMemoryDocClient({
      [keyOf(oosPk, oosSk)]: {
        pk: oosPk,
        sk: oosSk,
        entityType: 'OUT_OF_SERVICE_RECORD',
        startAt: recentStartAt,
      },
    });

    const result = await runDisposal({
      docClient: client,
      deptId: DEPT_ID,
      actorId: 'MBR-CHIEF',
      traceId: 'trace-disposal-2',
      nowEpochSeconds: nowEpoch,
      candidates: [{ pk: oosPk, sk: oosSk }],
    });

    expect(result.hardDeleted).toBe(0);
    expect(store.has(keyOf(oosPk, oosSk))).toBe(true);
  });

  it('uses stored retentionYears from CONFIG#RETENTION rather than a hardcoded constant', async () => {
    const nowEpoch = 1_800_000_000;
    // 6 years old — past a 5-year config, but inside the 7-year default
    const age = nowEpoch - 6 * SECONDS_PER_YEAR;
    const oosPk = buildDeptScopedPk(DEPT_ID, 'APPARATUS', 'APP-3');
    const oosSk = `OOS#${age}`;

    const { client, store } = createMemoryDocClient({
      [keyOf(buildDeptScopedPk(DEPT_ID), 'CONFIG#RETENTION')]: {
        pk: buildDeptScopedPk(DEPT_ID),
        sk: 'CONFIG#RETENTION',
        entityType: 'DEPARTMENT_CONFIG',
        configType: 'RETENTION',
        value: { retentionYears: 5 },
        version: 1,
      },
      [keyOf(oosPk, oosSk)]: {
        pk: oosPk,
        sk: oosSk,
        entityType: 'OUT_OF_SERVICE_RECORD',
        startAt: age,
      },
    });

    const result = await runDisposal({
      docClient: client,
      deptId: DEPT_ID,
      actorId: 'MBR-CHIEF',
      traceId: 'trace-disposal-3',
      nowEpochSeconds: nowEpoch,
      candidates: [{ pk: oosPk, sk: oosSk }],
    });

    expect(DEFAULT_RETENTION_YEARS).toBe(7);
    expect(result.retentionYearsUsed).toBe(5);
    expect(result.hardDeleted).toBe(1);
    expect(store.has(keyOf(oosPk, oosSk))).toBe(false);
  });

  it('refuses when caller spoofs OUT_OF_SERVICE_RECORD over a stored life-safety item', async () => {
    const nowEpoch = 1_800_000_000;
    const age = nowEpoch - 20 * SECONDS_PER_YEAR;
    const receiptPk = buildDeptScopedPk(DEPT_ID, 'ALERT', 'RCPT-1');
    const receiptSk = 'RECEIPT#1';

    const { client, store, send } = createMemoryDocClient({
      [keyOf(receiptPk, receiptSk)]: {
        pk: receiptPk,
        sk: receiptSk,
        entityType: 'DELIVERY_RECEIPT',
        startAt: age,
      },
    });

    const result = await runDisposal({
      docClient: client,
      deptId: DEPT_ID,
      actorId: 'MBR-CHIEF',
      traceId: 'trace-spoof-type',
      nowEpochSeconds: nowEpoch,
      // Caller-supplied entityType is no longer accepted; locator only.
      candidates: [{ pk: receiptPk, sk: receiptSk }],
    });

    expect(result.hardDeleted).toBe(0);
    expect(result.refused).toEqual(['DELIVERY_RECEIPT']);
    expect(store.has(keyOf(receiptPk, receiptSk))).toBe(true);
    expect(send.mock.calls.some((call) => call[0] instanceof DeleteCommand)).toBe(false);
  });

  it('refuses cross-dept pk and never deletes the foreign item', async () => {
    const nowEpoch = 1_800_000_000;
    const age = nowEpoch - 20 * SECONDS_PER_YEAR;
    const foreignPk = buildDeptScopedPk(OTHER_DEPT, 'APPARATUS', 'APP-X');
    const foreignSk = `OOS#${age}`;

    const { client, store, send } = createMemoryDocClient({
      [keyOf(foreignPk, foreignSk)]: {
        pk: foreignPk,
        sk: foreignSk,
        entityType: 'OUT_OF_SERVICE_RECORD',
        startAt: age,
      },
    });

    const result = await runDisposal({
      docClient: client,
      deptId: DEPT_ID,
      actorId: 'MBR-CHIEF',
      traceId: 'trace-cross-dept',
      nowEpochSeconds: nowEpoch,
      candidates: [{ pk: foreignPk, sk: foreignSk }],
    });

    expect(result.hardDeleted).toBe(0);
    expect(result.refused).toEqual([`CROSS_DEPT:${foreignPk}`]);
    expect(store.has(keyOf(foreignPk, foreignSk))).toBe(true);
    // Dept-scope check runs before GetItem — never touch the foreign key.
    const candidateGets = send.mock.calls.filter((call) => {
      const cmd = call[0];
      return (
        cmd instanceof GetCommand &&
        cmd.input.Key?.pk === foreignPk &&
        cmd.input.Key?.sk === foreignSk
      );
    });
    expect(candidateGets).toHaveLength(0);
    expect(send.mock.calls.some((call) => call[0] instanceof DeleteCommand)).toBe(false);
  });

  it('refuses missing items without DeleteItem', async () => {
    const nowEpoch = 1_800_000_000;
    const missingPk = buildDeptScopedPk(DEPT_ID, 'APPARATUS', 'GONE');
    const missingSk = 'OOS#1';
    const { client, send } = createMemoryDocClient();

    const result = await runDisposal({
      docClient: client,
      deptId: DEPT_ID,
      actorId: 'MBR-CHIEF',
      traceId: 'trace-missing',
      nowEpochSeconds: nowEpoch,
      candidates: [{ pk: missingPk, sk: missingSk }],
    });

    expect(result.hardDeleted).toBe(0);
    expect(result.refused).toEqual([`MISSING:${missingPk}#${missingSk}`]);
    expect(send.mock.calls.some((call) => call[0] instanceof DeleteCommand)).toBe(false);
  });
});
