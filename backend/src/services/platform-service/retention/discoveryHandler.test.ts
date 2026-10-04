import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GetCommand, ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildDeptScopedPk, toVerifiedDeptId } from '@boxalarm/dept-scope';
import { SECONDS_PER_YEAR } from './disposal.js';
import { createHandler } from './discoveryHandler.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });

const originalEnv = { ...process.env };

interface DiscoveryScanLog {
  readonly service: string;
  readonly event: string;
  readonly candidateCount: number;
  readonly truncated: boolean;
  readonly sample: readonly string[];
}

interface DisposalCandidatesFoundEmf {
  readonly DisposalCandidatesFound: number;
}

function parseLoggedLines(logSpy: ReturnType<typeof vi.fn>): string[] {
  return logSpy.mock.calls.map((call) => String(call[0]));
}

beforeEach(() => {
  process.env.PLATFORM_TABLE_NAME = 'platform-service';
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

function fakeDocClient(items: Record<string, unknown>[], configItem?: Record<string, unknown>) {
  const send = vi.fn((command: unknown) => {
    if (command instanceof GetCommand) {
      return configItem ? { Item: configItem } : {};
    }
    if (command instanceof ScanCommand) {
      return { Items: items };
    }
    return {};
  });
  return { docClient: { send } as unknown as DynamoDBDocumentClient, send };
}

describe('retention discovery scheduled handler (#260)', () => {
  it('emits DisposalCandidatesFound with 0 and logs no scan summary when nothing is found', async () => {
    const { docClient } = fakeDocClient([]);
    const handler = createHandler({ docClient });

    await handler({} as never, {} as never, {} as never);

    const logSpy = console.log as unknown as ReturnType<typeof vi.fn>;
    const logged = parseLoggedLines(logSpy);
    const metricLine = logged.find((l) => l.includes('DisposalCandidatesFound'));
    expect(metricLine).toBeDefined();
    const metric = JSON.parse(metricLine as string) as DisposalCandidatesFoundEmf;
    expect(metric.DisposalCandidatesFound).toBe(0);
    expect(logged.some((l) => l.includes('retention.discovery.scan'))).toBe(false);
  });

  it('emits the candidate count and logs a capped locator sample when candidates are found', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const tooOldEndAt = 1_800_000_000 - 10 * SECONDS_PER_YEAR;
    const oosPk = buildDeptScopedPk(DEPT_ID, 'APPARATUS', 'APP-1');
    const oosSk = `OOS#${tooOldEndAt - 1}`;

    const { docClient } = fakeDocClient([
      {
        pk: oosPk,
        sk: oosSk,
        entityType: 'OUT_OF_SERVICE_RECORD',
        endAt: tooOldEndAt,
      },
    ]);
    const handler = createHandler({ docClient });

    await handler({} as never, {} as never, {} as never);

    const logSpy = console.log as unknown as ReturnType<typeof vi.fn>;
    const logged = parseLoggedLines(logSpy).map(
      (l) => JSON.parse(l) as Partial<DiscoveryScanLog & DisposalCandidatesFoundEmf>,
    );

    const metricLine = logged.find((l) => l.DisposalCandidatesFound !== undefined);
    expect(metricLine?.DisposalCandidatesFound).toBe(1);

    const scanLine = logged.find((l) => l.event === 'retention.discovery.scan');
    expect(scanLine?.candidateCount).toBe(1);
    expect(scanLine?.truncated).toBe(false);
    expect(scanLine?.sample).toEqual([`${DEPT_ID}:OUT_OF_SERVICE_RECORD:${oosPk}#${oosSk}`]);

    nowSpy.mockRestore();
  });

  it('never calls DeleteCommand/UpdateCommand/PutCommand — discovery is read-only', async () => {
    const tooOldEndAt = 1_800_000_000 - 10 * SECONDS_PER_YEAR;
    const oosPk = buildDeptScopedPk(DEPT_ID, 'APPARATUS', 'APP-2');
    const oosSk = `OOS#${tooOldEndAt - 1}`;
    const { docClient, send } = fakeDocClient([
      { pk: oosPk, sk: oosSk, entityType: 'OUT_OF_SERVICE_RECORD', endAt: tooOldEndAt },
    ]);
    const handler = createHandler({ docClient });

    await handler({} as never, {} as never, {} as never);

    const calledCommandNames = send.mock.calls.map(
      (call) => (call[0] as { constructor: { name: string } }).constructor.name,
    );
    expect(calledCommandNames).toEqual(expect.arrayContaining(['ScanCommand']));
    expect(calledCommandNames).not.toContain('DeleteCommand');
    expect(calledCommandNames).not.toContain('UpdateCommand');
    expect(calledCommandNames).not.toContain('PutCommand');
  });

  it('throws when PLATFORM_TABLE_NAME is not set', async () => {
    delete process.env.PLATFORM_TABLE_NAME;
    const handler = createHandler({ docClient: fakeDocClient([]).docClient });
    await expect(handler({} as never, {} as never, {} as never)).rejects.toThrow(
      /PLATFORM_TABLE_NAME is required/,
    );
  });
});
