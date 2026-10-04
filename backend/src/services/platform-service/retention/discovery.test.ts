import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GetCommand, ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { SECONDS_PER_YEAR } from './disposal.js';
import { discoverDisposalCandidates } from './discovery.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const OTHER_DEPT = toVerifiedDeptId({ deptId: 'TRUMBULL' });

function keyOf(pk: string, sk: string): string {
  return `${pk}\0${sk}`;
}

/** In-memory Dynamo stand-in supporting Scan (paginated) + GetItem (config reads). */
function createMemoryDocClient(seed: Record<string, Record<string, unknown>> = {}) {
  const store = new Map<string, Record<string, unknown>>(
    Object.entries(seed).map(([key, value]) => [key, { ...value }]),
  );
  const items = [...store.values()];

  const send = vi.fn((command: unknown) => {
    if (command instanceof GetCommand) {
      const pk = command.input.Key?.pk as string;
      const sk = command.input.Key?.sk as string;
      const item = store.get(keyOf(pk, sk));
      return item ? { Item: item } : {};
    }
    if (command instanceof ScanCommand) {
      // Single page by default: pagination is exercised by its own dedicated test.
      return { Items: items };
    }
    return {};
  });

  return { client: { send } as unknown as DynamoDBDocumentClient, store, send };
}

describe('discoverDisposalCandidates', () => {
  beforeEach(() => {
    process.env.PLATFORM_TABLE_NAME = 'platform-service';
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('finds an OUT_OF_SERVICE_RECORD past the configured retention window', async () => {
    const nowEpoch = 1_800_000_000;
    const retentionYears = 5;
    const tooOldEndAt = nowEpoch - retentionYears * SECONDS_PER_YEAR - 1;
    const oosPk = buildDeptScopedPk(DEPT_ID, 'APPARATUS', 'APP-1');
    const oosSk = `OOS#${tooOldEndAt - 86_400}`;

    const { client } = createMemoryDocClient({
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
        startAt: tooOldEndAt - 86_400,
        endAt: tooOldEndAt,
      },
    });

    const candidates = await discoverDisposalCandidates({
      docClient: client,
      tableName: 'platform-service',
      nowEpochSeconds: nowEpoch,
    });

    expect(candidates).toEqual([
      { deptId: DEPT_ID, pk: oosPk, sk: oosSk, entityType: 'OUT_OF_SERVICE_RECORD' },
    ]);
  });

  it('skips an OUT_OF_SERVICE_RECORD still inside the retention window', async () => {
    const nowEpoch = 1_800_000_000;
    const recentEndAt = nowEpoch - 100;
    const oosPk = buildDeptScopedPk(DEPT_ID, 'APPARATUS', 'APP-2');
    const oosSk = `OOS#${recentEndAt - 10}`;

    const { client } = createMemoryDocClient({
      [keyOf(oosPk, oosSk)]: {
        pk: oosPk,
        sk: oosSk,
        entityType: 'OUT_OF_SERVICE_RECORD',
        startAt: recentEndAt - 10,
        endAt: recentEndAt,
      },
    });

    const candidates = await discoverDisposalCandidates({
      docClient: client,
      tableName: 'platform-service',
      nowEpochSeconds: nowEpoch,
    });

    expect(candidates).toEqual([]);
  });

  it('never surfaces a life-safety entity type, even past any age', async () => {
    const nowEpoch = 1_800_000_000;
    const age = nowEpoch - 20 * SECONDS_PER_YEAR;
    const receiptPk = buildDeptScopedPk(DEPT_ID, 'ALERT', 'RCPT-1');
    const receiptSk = 'RECEIPT#1';

    const { client } = createMemoryDocClient({
      [keyOf(receiptPk, receiptSk)]: {
        pk: receiptPk,
        sk: receiptSk,
        entityType: 'DELIVERY_RECEIPT',
        startAt: age,
        archivedAt: age,
      },
    });

    const candidates = await discoverDisposalCandidates({
      docClient: client,
      tableName: 'platform-service',
      nowEpochSeconds: nowEpoch,
    });

    // The scan's own FilterExpression never requests DELIVERY_RECEIPT in the first
    // place — this proves that holds, not just that age-derivation later refuses it.
    expect(candidates).toEqual([]);
  });

  it('finds an open OOS record with no endAt as never a candidate (age is undefined)', async () => {
    const nowEpoch = 1_800_000_000;
    const veryOldStartAt = nowEpoch - 50 * SECONDS_PER_YEAR;
    const oosPk = buildDeptScopedPk(DEPT_ID, 'APPARATUS', 'APP-3');
    const oosSk = `OOS#${veryOldStartAt}`;

    const { client } = createMemoryDocClient({
      [keyOf(oosPk, oosSk)]: {
        pk: oosPk,
        sk: oosSk,
        entityType: 'OUT_OF_SERVICE_RECORD',
        startAt: veryOldStartAt,
        // No endAt: the apparatus may still be out of service today.
      },
    });

    const candidates = await discoverDisposalCandidates({
      docClient: client,
      tableName: 'platform-service',
      nowEpochSeconds: nowEpoch,
    });

    expect(candidates).toEqual([]);
  });

  it("applies each department's own retentionYears, looked up once per department", async () => {
    const nowEpoch = 1_800_000_000;
    // 6 years old: past a 5-year config (NICHOLS) but inside the 7-year default (TRUMBULL).
    const age = nowEpoch - 6 * SECONDS_PER_YEAR;
    const nicholsPk = buildDeptScopedPk(DEPT_ID, 'APPARATUS', 'APP-4');
    const nicholsSk = `OOS#${age}`;
    const trumbullPk = buildDeptScopedPk(OTHER_DEPT, 'APPARATUS', 'APP-5');
    const trumbullSk = `OOS#${age}`;

    const { client, send } = createMemoryDocClient({
      [keyOf(buildDeptScopedPk(DEPT_ID), 'CONFIG#RETENTION')]: {
        pk: buildDeptScopedPk(DEPT_ID),
        sk: 'CONFIG#RETENTION',
        entityType: 'DEPARTMENT_CONFIG',
        configType: 'RETENTION',
        value: { retentionYears: 5 },
        version: 1,
      },
      [keyOf(nicholsPk, nicholsSk)]: {
        pk: nicholsPk,
        sk: nicholsSk,
        entityType: 'OUT_OF_SERVICE_RECORD',
        startAt: age,
        endAt: age,
      },
      [keyOf(trumbullPk, trumbullSk)]: {
        pk: trumbullPk,
        sk: trumbullSk,
        entityType: 'OUT_OF_SERVICE_RECORD',
        startAt: age,
        endAt: age,
      },
    });

    const candidates = await discoverDisposalCandidates({
      docClient: client,
      tableName: 'platform-service',
      nowEpochSeconds: nowEpoch,
    });

    expect(candidates).toEqual([
      { deptId: DEPT_ID, pk: nicholsPk, sk: nicholsSk, entityType: 'OUT_OF_SERVICE_RECORD' },
    ]);
    // One GetItem for NICHOLS's config (TRUMBULL falls back to the default without a
    // stored row) — not one per scanned item, which would be N reads for N rows.
    const configReads = send.mock.calls.filter(
      (call) => call[0] instanceof GetCommand && call[0].input.Key?.sk === 'CONFIG#RETENTION',
    );
    expect(configReads).toHaveLength(2);
  });

  it('pages through ScanCommand via ExclusiveStartKey/LastEvaluatedKey', async () => {
    const nowEpoch = 1_800_000_000;
    const tooOldEndAt = nowEpoch - 10 * SECONDS_PER_YEAR;
    const pkA = buildDeptScopedPk(DEPT_ID, 'APPARATUS', 'APP-A');
    const skA = `OOS#${tooOldEndAt - 1}`;
    const pkB = buildDeptScopedPk(DEPT_ID, 'APPARATUS', 'APP-B');
    const skB = `OOS#${tooOldEndAt - 2}`;

    const itemA = { pk: pkA, sk: skA, entityType: 'OUT_OF_SERVICE_RECORD', endAt: tooOldEndAt };
    const itemB = { pk: pkB, sk: skB, entityType: 'OUT_OF_SERVICE_RECORD', endAt: tooOldEndAt };

    let call = 0;
    const send = vi.fn((command: unknown) => {
      if (command instanceof GetCommand) {
        return {};
      }
      if (command instanceof ScanCommand) {
        call += 1;
        if (call === 1) {
          return { Items: [itemA], LastEvaluatedKey: { pk: pkA, sk: skA } };
        }
        expect(command.input.ExclusiveStartKey).toEqual({ pk: pkA, sk: skA });
        return { Items: [itemB] };
      }
      return {};
    });

    const candidates = await discoverDisposalCandidates({
      docClient: { send } as unknown as DynamoDBDocumentClient,
      tableName: 'platform-service',
      nowEpochSeconds: nowEpoch,
    });

    expect(candidates.map((c) => c.pk).sort()).toEqual([pkA, pkB].sort());
    expect(call).toBe(2);
  });
});
