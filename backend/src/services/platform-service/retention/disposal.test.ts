import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { DEFAULT_RETENTION_YEARS } from './configRepository.js';
import { SECONDS_PER_YEAR, runDisposal } from './disposal.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const OTHER_DEPT = toVerifiedDeptId({ deptId: 'TRUMBULL' });

function keyOf(pk: string, sk: string): string {
  return `${pk}\0${sk}`;
}

/** In-memory Dynamo stand-in so hard-delete is proven via GetItem, not mock call counts. */
function createMemoryDocClient(
  seed: Record<string, Record<string, unknown>> = {},
  options: { failDeleteFor?: string } = {},
) {
  const store = new Map<string, Record<string, unknown>>(
    Object.entries(seed).map(([key, value]) => [key, { ...value }]),
  );
  const puts: Record<string, unknown>[] = [];

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
      if (options.failDeleteFor && keyOf(pk, sk) === options.failDeleteFor) {
        throw new ConditionalCheckFailedException({
          message: 'The conditional request failed',
          $metadata: {},
        });
      }
      store.delete(keyOf(pk, sk));
      return {};
    }
    if (command instanceof PutCommand) {
      const item = command.input.Item as Record<string, unknown>;
      puts.push(item);
      return {};
    }
    return {};
  });

  return {
    client: { send } as unknown as DynamoDBDocumentClient,
    store,
    puts,
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
    // Age is derived from endAt (the record closed and is disposable); startAt is simply
    // earlier still (when the apparatus WENT out of service).
    const tooOldEndAt = nowEpoch - retentionYears * SECONDS_PER_YEAR - 1;
    const tooOldStartAt = tooOldEndAt - 86_400;
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
        endAt: tooOldEndAt,
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
        // Closed record: age is derived from endAt, not startAt (see the endAt-vs-startAt
        // test below), so this must carry an endAt to be eligible for disposal at all.
        endAt: age,
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

  it('reads with ConsistentRead: true before authorizing a destructive delete', async () => {
    const nowEpoch = 1_800_000_000;
    const age = nowEpoch - 20 * SECONDS_PER_YEAR;
    const oosPk = buildDeptScopedPk(DEPT_ID, 'APPARATUS', 'APP-CR');
    const oosSk = `OOS#${age}`;
    const { client, send } = createMemoryDocClient({
      [keyOf(oosPk, oosSk)]: {
        pk: oosPk,
        sk: oosSk,
        entityType: 'OUT_OF_SERVICE_RECORD',
        startAt: age,
        endAt: age,
      },
    });

    await runDisposal({
      docClient: client,
      deptId: DEPT_ID,
      actorId: 'MBR-CHIEF',
      traceId: 'trace-consistent-read',
      nowEpochSeconds: nowEpoch,
      candidates: [{ pk: oosPk, sk: oosSk }],
    });

    // The first GetCommand is configRepository's retention-config lookup, which has no
    // ConsistentRead requirement — find the one keyed to the actual candidate.
    const get = send.mock.calls.find(
      (call) =>
        call[0] instanceof GetCommand &&
        call[0].input.Key?.pk === oosPk &&
        call[0].input.Key?.sk === oosSk,
    )?.[0] as GetCommand;
    expect(get.input.ConsistentRead).toBe(true);
  });

  it('ties the DeleteCommand to the entityType just validated via ConditionExpression', async () => {
    const nowEpoch = 1_800_000_000;
    const age = nowEpoch - 20 * SECONDS_PER_YEAR;
    const oosPk = buildDeptScopedPk(DEPT_ID, 'APPARATUS', 'APP-COND');
    const oosSk = `OOS#${age}`;
    const { client, send } = createMemoryDocClient({
      [keyOf(oosPk, oosSk)]: {
        pk: oosPk,
        sk: oosSk,
        entityType: 'OUT_OF_SERVICE_RECORD',
        startAt: age,
        endAt: age,
      },
    });

    await runDisposal({
      docClient: client,
      deptId: DEPT_ID,
      actorId: 'MBR-CHIEF',
      traceId: 'trace-condition-expr',
      nowEpochSeconds: nowEpoch,
      candidates: [{ pk: oosPk, sk: oosSk }],
    });

    const del = send.mock.calls.find((call) => call[0] instanceof DeleteCommand)?.[0] as
      DeleteCommand | undefined;
    expect(del?.input.ConditionExpression).toBe('entityType = :entityType');
    expect(del?.input.ExpressionAttributeValues).toEqual({
      ':entityType': 'OUT_OF_SERVICE_RECORD',
    });
  });

  it('refuses (not aborts) a candidate whose DeleteCommand loses a concurrent-write race', async () => {
    const nowEpoch = 1_800_000_000;
    const age = nowEpoch - 20 * SECONDS_PER_YEAR;
    const racedPk = buildDeptScopedPk(DEPT_ID, 'APPARATUS', 'APP-RACE');
    const racedSk = `OOS#${age}`;
    const okPk = buildDeptScopedPk(DEPT_ID, 'APPARATUS', 'APP-OK');
    const okSk = `OOS#${age}`;

    const { client, store } = createMemoryDocClient(
      {
        [keyOf(racedPk, racedSk)]: {
          pk: racedPk,
          sk: racedSk,
          entityType: 'OUT_OF_SERVICE_RECORD',
          startAt: age,
          endAt: age,
        },
        [keyOf(okPk, okSk)]: {
          pk: okPk,
          sk: okSk,
          entityType: 'OUT_OF_SERVICE_RECORD',
          startAt: age,
          endAt: age,
        },
      },
      { failDeleteFor: keyOf(racedPk, racedSk) },
    );

    const result = await runDisposal({
      docClient: client,
      deptId: DEPT_ID,
      actorId: 'MBR-CHIEF',
      traceId: 'trace-race',
      nowEpochSeconds: nowEpoch,
      // The raced candidate is deliberately processed first so a naive implementation
      // would abort the batch and never reach the second, valid candidate.
      candidates: [
        { pk: racedPk, sk: racedSk },
        { pk: okPk, sk: okSk },
      ],
    });

    expect(result.hardDeleted).toBe(1);
    expect(result.refused).toEqual([
      `DISPOSAL_FAILED:${racedPk}#${racedSk}:CONCURRENT_MODIFICATION`,
    ]);
    expect(store.has(keyOf(racedPk, racedSk))).toBe(true);
    expect(store.has(keyOf(okPk, okSk))).toBe(false);
  });

  it('never disposes an open OUT_OF_SERVICE_RECORD (no endAt), however old startAt is', async () => {
    const nowEpoch = 1_800_000_000;
    const veryOldStartAt = nowEpoch - 30 * SECONDS_PER_YEAR;
    const oosPk = buildDeptScopedPk(DEPT_ID, 'APPARATUS', 'APP-OPEN');
    const oosSk = `OOS#${veryOldStartAt}`;

    const { client, store } = createMemoryDocClient({
      [keyOf(oosPk, oosSk)]: {
        pk: oosPk,
        sk: oosSk,
        entityType: 'OUT_OF_SERVICE_RECORD',
        reason: 'Engine rebuild',
        startAt: veryOldStartAt,
        // No endAt: the apparatus is still out of service.
      },
    });

    const result = await runDisposal({
      docClient: client,
      deptId: DEPT_ID,
      actorId: 'MBR-CHIEF',
      traceId: 'trace-open-oos',
      nowEpochSeconds: nowEpoch,
      candidates: [{ pk: oosPk, sk: oosSk }],
    });

    expect(result.hardDeleted).toBe(0);
    expect(result.refused).toEqual([]);
    expect(store.has(keyOf(oosPk, oosSk))).toBe(true);
  });

  it('derives OUT_OF_SERVICE_RECORD age from endAt, not startAt', async () => {
    const nowEpoch = 1_800_000_000;
    const retentionYears = 5;
    // Went out of service long ago (way past retention by startAt)...
    const veryOldStartAt = nowEpoch - 20 * SECONDS_PER_YEAR;
    // ...but returned to service recently — the closed record is NOT past retention.
    const recentEndAt = nowEpoch - 100;
    const oosPk = buildDeptScopedPk(DEPT_ID, 'APPARATUS', 'APP-ENDAT');
    const oosSk = `OOS#${veryOldStartAt}`;

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
        startAt: veryOldStartAt,
        endAt: recentEndAt,
      },
    });

    const result = await runDisposal({
      docClient: client,
      deptId: DEPT_ID,
      actorId: 'MBR-CHIEF',
      traceId: 'trace-endat-age',
      nowEpochSeconds: nowEpoch,
      candidates: [{ pk: oosPk, sk: oosSk }],
    });

    expect(result.hardDeleted).toBe(0);
    expect(store.has(keyOf(oosPk, oosSk))).toBe(true);
  });

  it('refuses an entityType outside every known disposal/life-safety classification', async () => {
    const nowEpoch = 1_800_000_000;
    const age = nowEpoch - 20 * SECONDS_PER_YEAR;
    const pk = buildDeptScopedPk(DEPT_ID, 'WHATEVER', 'X-1');
    const sk = 'ITEM#1';
    const { client } = createMemoryDocClient({
      [keyOf(pk, sk)]: {
        pk,
        sk,
        entityType: 'SOME_UNKNOWN_TYPE',
        startAt: age,
      },
    });

    const result = await runDisposal({
      docClient: client,
      deptId: DEPT_ID,
      actorId: 'MBR-CHIEF',
      traceId: 'trace-unsupported',
      nowEpochSeconds: nowEpoch,
      candidates: [{ pk, sk }],
    });

    expect(result.hardDeleted).toBe(0);
    expect(result.refused).toEqual(['UNSUPPORTED_ENTITY:SOME_UNKNOWN_TYPE']);
  });

  it('records disposed locators on the AUDIT_LOG_ENTRY, not just aggregate counts', async () => {
    const nowEpoch = 1_800_000_000;
    const age = nowEpoch - 20 * SECONDS_PER_YEAR;
    const oosPk = buildDeptScopedPk(DEPT_ID, 'APPARATUS', 'APP-AUDIT');
    const oosSk = `OOS#${age}`;
    const { client, puts } = createMemoryDocClient({
      [keyOf(oosPk, oosSk)]: {
        pk: oosPk,
        sk: oosSk,
        entityType: 'OUT_OF_SERVICE_RECORD',
        startAt: age,
        endAt: age,
      },
    });

    await runDisposal({
      docClient: client,
      deptId: DEPT_ID,
      actorId: 'MBR-CHIEF',
      traceId: 'trace-audit-locators',
      nowEpochSeconds: nowEpoch,
      candidates: [{ pk: oosPk, sk: oosSk }],
    });

    const audit = puts.find((item) => item.entityType === 'AUDIT_LOG_ENTRY') as
      { changedFields: { disposedLocators: { new: readonly string[] } } } | undefined;
    expect(audit?.changedFields.disposedLocators.new).toEqual([`${oosPk}#${oosSk}`]);
  });
});
