import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  DuplicateApparatusError,
  createApparatusRepository,
  getDocumentClient,
  getTableName,
} from './apparatusRepository.js';

const DEPT_ID = toVerifiedDeptId({ deptId: 'NICHOLS' });
const TABLE_NAME = 'boxalarm-dev-platform';

function fakeClient(send: (command: unknown) => unknown): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

describe('createApparatusRepository', () => {
  it('lists apparatus by querying GSI3 scoped to the department, never a raw pk', async () => {
    const send = vi.fn().mockResolvedValue({
      Items: [
        { apparatusId: 'APP-ENGINE-2', unitId: 'ENGINE-2', type: 'ENGINE', status: 'IN_SERVICE' },
      ],
    });
    const repository = createApparatusRepository(fakeClient(send), TABLE_NAME);

    const result = await repository.listApparatus(DEPT_ID);

    expect(result).toEqual([
      { apparatusId: 'APP-ENGINE-2', unitId: 'ENGINE-2', type: 'ENGINE', status: 'IN_SERVICE' },
    ]);
    const [command] = send.mock.calls[0] as [{ input: Record<string, unknown> }];
    expect(command.input).toMatchObject({
      TableName: TABLE_NAME,
      IndexName: 'GSI3',
      KeyConditionExpression: 'gsi3pk = :gsi3pk',
      ExpressionAttributeValues: { ':gsi3pk': 'DEPT#NICHOLS#APPARATUS' },
    });
  });

  it('resolves detail via gsi3pk/gsi3sk on unitId, never a direct GetItem by unitId', async () => {
    const send = vi.fn().mockResolvedValue({
      Items: [
        { apparatusId: 'APP-ENGINE-2', unitId: 'ENGINE-2', type: 'ENGINE', status: 'IN_SERVICE' },
      ],
    });
    const repository = createApparatusRepository(fakeClient(send), TABLE_NAME);

    const result = await repository.getApparatusByUnitId(DEPT_ID, 'ENGINE-2');

    expect(result).toEqual({
      apparatusId: 'APP-ENGINE-2',
      unitId: 'ENGINE-2',
      type: 'ENGINE',
      status: 'IN_SERVICE',
    });
    const [command] = send.mock.calls[0] as [{ input: Record<string, unknown> }];
    expect(command.input).toMatchObject({
      KeyConditionExpression: 'gsi3pk = :gsi3pk AND gsi3sk = :gsi3sk',
      ExpressionAttributeValues: {
        ':gsi3pk': 'DEPT#NICHOLS#APPARATUS',
        ':gsi3sk': 'ENGINE-2',
      },
    });
  });

  it('returns undefined when no apparatus matches the unitId', async () => {
    const send = vi.fn().mockResolvedValue({ Items: [] });
    const repository = createApparatusRepository(fakeClient(send), TABLE_NAME);

    const result = await repository.getApparatusByUnitId(DEPT_ID, 'ENGINE-9');

    expect(result).toBeUndefined();
  });

  it('creates apparatus with a pk/gsi3pk built only via buildDeptScopedPk, defaulting status to IN_SERVICE', async () => {
    const send = vi.fn().mockResolvedValue({});
    const repository = createApparatusRepository(fakeClient(send), TABLE_NAME);

    const result = await repository.createApparatus(DEPT_ID, {
      unitId: 'ENGINE-2',
      type: 'ENGINE',
      status: 'IN_SERVICE',
    });

    expect(result).toEqual({
      apparatusId: 'APP-ENGINE-2',
      unitId: 'ENGINE-2',
      type: 'ENGINE',
      status: 'IN_SERVICE',
    });
    const [command] = send.mock.calls[0] as [{ input: Record<string, unknown> }];
    expect(command.input).toMatchObject({
      TableName: TABLE_NAME,
      Item: {
        pk: 'DEPT#NICHOLS#APPARATUS#APP-ENGINE-2',
        sk: 'METADATA',
        entityType: 'APPARATUS',
        gsi3pk: 'DEPT#NICHOLS#APPARATUS',
        gsi3sk: 'ENGINE-2',
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
  });

  it('rejects a duplicate unitId as DuplicateApparatusError (conditional-put dup rejection)', async () => {
    const send = vi
      .fn()
      .mockRejectedValue(new ConditionalCheckFailedException({ message: 'dup', $metadata: {} }));
    const repository = createApparatusRepository(fakeClient(send), TABLE_NAME);

    await expect(
      repository.createApparatus(DEPT_ID, {
        unitId: 'ENGINE-2',
        type: 'ENGINE',
        status: 'IN_SERVICE',
      }),
    ).rejects.toThrow(DuplicateApparatusError);
  });

  it('propagates a non-conditional DynamoDB failure rather than swallowing it', async () => {
    const send = vi.fn().mockRejectedValue(new Error('ProvisionedThroughputExceededException'));
    const repository = createApparatusRepository(fakeClient(send), TABLE_NAME);

    await expect(repository.listApparatus(DEPT_ID)).rejects.toThrow(
      'ProvisionedThroughputExceededException',
    );
  });
});

describe('getApparatusDetail (AC3)', () => {
  function fakeDetailClient(options: {
    readonly apparatusItems?: Record<string, unknown>[];
    readonly defectItems?: Record<string, unknown>[];
    readonly testItems?: Record<string, unknown>[];
  }): { readonly client: DynamoDBDocumentClient; readonly send: ReturnType<typeof vi.fn> } {
    const send = vi.fn((command: unknown) => {
      const input = (command as { input: Record<string, unknown> }).input;
      const values = input.ExpressionAttributeValues as Record<string, unknown>;
      const prefix = values?.[':prefix'];
      if (prefix === 'DEFECT#') {
        // Honor the real FilterExpression (#status = :open) so a fixture with a non-OPEN
        // defect actually proves it gets excluded, rather than the fake client always
        // returning the whole fixture regardless of what the handler filtered for.
        const openValue = values?.[':open'];
        const items = (options.defectItems ?? []).filter((item) => item.status === openValue);
        return Promise.resolve({ Items: items });
      }
      if (prefix === 'TEST#') {
        return Promise.resolve({ Items: options.testItems ?? [] });
      }
      return Promise.resolve({ Items: options.apparatusItems ?? [] });
    });
    return { client: fakeClient(send), send };
  }

  it('returns undefined when no apparatus matches the unitId', async () => {
    const { client } = fakeDetailClient({ apparatusItems: [] });
    const repository = createApparatusRepository(client, TABLE_NAME);

    const result = await repository.getApparatusDetail(DEPT_ID, 'ENGINE-9');

    expect(result).toBeUndefined();
  });

  it('composes base apparatus with open defects and the latest FAIL per testType', async () => {
    const { client } = fakeDetailClient({
      apparatusItems: [
        { apparatusId: 'APP-ENGINE-2', unitId: 'ENGINE-2', type: 'ENGINE', status: 'IN_SERVICE' },
      ],
      defectItems: [
        {
          defectId: 'DEF-1',
          description: 'Low tire pressure',
          severity: 'MINOR',
          reportedAt: 1798050000,
          status: 'OPEN',
          photoS3Key: 'dept-1/defect/DEF-1/tire.jpg',
        },
        {
          defectId: 'DEF-0',
          description: 'Already repaired brake pad',
          severity: 'MAJOR',
          reportedAt: 1797000000,
          status: 'CLOSED',
        },
      ],
      testItems: [
        { testType: 'HOSE', testDate: '2026-05-01', result: 'FAIL', nextDueDate: '2027-05-01' },
        { testType: 'LADDER', testDate: '2026-04-01', result: 'PASS', nextDueDate: '2027-04-01' },
      ],
    });
    const repository = createApparatusRepository(client, TABLE_NAME);

    const result = await repository.getApparatusDetail(DEPT_ID, 'ENGINE-2');

    expect(result).toEqual({
      apparatusId: 'APP-ENGINE-2',
      unitId: 'ENGINE-2',
      type: 'ENGINE',
      status: 'IN_SERVICE',
      openDefects: [
        {
          defectId: 'DEF-1',
          description: 'Low tire pressure',
          severity: 'MINOR',
          reportedAt: 1798050000,
          photoS3Key: 'dept-1/defect/DEF-1/tire.jpg',
        },
      ],
      failedTests: [{ testType: 'HOSE', testDate: '2026-05-01', nextDueDate: '2027-05-01' }],
    });
  });

  it('returns a null photoS3Key when the defect has no photo', async () => {
    const { client } = fakeDetailClient({
      apparatusItems: [
        { apparatusId: 'APP-ENGINE-2', unitId: 'ENGINE-2', type: 'ENGINE', status: 'IN_SERVICE' },
      ],
      defectItems: [
        {
          defectId: 'DEF-2',
          description: 'Cracked mirror',
          severity: 'MINOR',
          reportedAt: 1798050100,
          status: 'OPEN',
        },
      ],
      testItems: [],
    });
    const repository = createApparatusRepository(client, TABLE_NAME);

    const result = await repository.getApparatusDetail(DEPT_ID, 'ENGINE-2');

    expect(result?.openDefects[0]?.photoS3Key).toBeNull();
  });

  it('returns empty openDefects/failedTests when there are none', async () => {
    const { client } = fakeDetailClient({
      apparatusItems: [
        { apparatusId: 'APP-ENGINE-2', unitId: 'ENGINE-2', type: 'ENGINE', status: 'IN_SERVICE' },
      ],
      defectItems: [],
      testItems: [
        { testType: 'HOSE', testDate: '2026-05-01', result: 'PASS', nextDueDate: '2027-05-01' },
      ],
    });
    const repository = createApparatusRepository(client, TABLE_NAME);

    const result = await repository.getApparatusDetail(DEPT_ID, 'ENGINE-2');

    expect(result?.openDefects).toEqual([]);
    expect(result?.failedTests).toEqual([]);
  });
});

describe('getTableName', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('throws when PLATFORM_TABLE_NAME is unset', () => {
    const env = { ...process.env };
    delete env.PLATFORM_TABLE_NAME;
    expect(() => getTableName(env)).toThrow(/PLATFORM_TABLE_NAME/);
  });

  it('throws when PLATFORM_TABLE_NAME is empty', () => {
    expect(() => getTableName({ PLATFORM_TABLE_NAME: '' })).toThrow(/PLATFORM_TABLE_NAME/);
  });

  it('returns the configured table name when set', () => {
    expect(getTableName({ PLATFORM_TABLE_NAME: 'boxalarm-dev-platform' })).toBe(
      'boxalarm-dev-platform',
    );
  });
});

describe('getDocumentClient', () => {
  it('memoizes the DynamoDB document client across calls', () => {
    expect(getDocumentClient()).toBe(getDocumentClient());
  });
});
